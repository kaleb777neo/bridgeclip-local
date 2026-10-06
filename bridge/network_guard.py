"""Block local and private TCP destinations for the desktop clipping process.

The guard checks the address passed to connect, after DNS resolution. This
also catches redirects and DNS changes made after the UI's initial URL check.
It is installed only in BridgeClip's local worker process.

The local AI backend (Ollama at 127.0.0.1) is the one exception: when the
bridge enables it, loopback connections to the configured Ollama port are
allowed. Everything else private stays blocked.
"""

import ipaddress
import socket
import sys

_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
_installed = False
_allowed_loopback_ports: frozenset[int] = frozenset()


def _loopback_allowed(port: object) -> bool:
    return isinstance(port, int) and port in _allowed_loopback_ports


def _internal_socketpair(family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0):
    """Build a self-connected pair without exempting ordinary loopback traffic.

    Windows implements socket.socketpair() by connecting to a temporary local
    listener. Use the original connect only for the client socket created here;
    all other connects continue through the destination guard.
    """
    if family not in (socket.AF_INET, socket.AF_INET6):
        raise ValueError("Only AF_INET and AF_INET6 socket pairs are supported")
    if type != socket.SOCK_STREAM or proto != 0:
        raise ValueError("Only stream socket pairs with protocol zero are supported")
    host = "127.0.0.1" if family == socket.AF_INET else "::1"
    listener = socket.socket(family, type, proto)
    try:
        listener.bind((host, 0))
        listener.listen()
        address = listener.getsockname()[:2]
        client = socket.socket(family, type, proto)
        try:
            client.setblocking(False)
            try:
                _original_connect(client, address)
            except (BlockingIOError, InterruptedError):
                pass
            client.setblocking(True)
            server, _ = listener.accept()
        except BaseException:
            client.close()
            raise
    finally:
        listener.close()
    try:
        if server.getsockname() != client.getpeername() or client.getsockname() != server.getpeername():
            raise ConnectionError("Unexpected socket pair peer")
    except BaseException:
        server.close()
        client.close()
        raise
    return server, client


def _public_ip(ip):
    """`is_global` with 6to4/Teredo/mapped-IPv4 unpacking and 192.0.0.0/24 fixed.

    The stdlib only learned to look inside those tunnels in 3.13, and only
    classified the IETF protocol-assignment range as non-global in later
    releases; on older runtimes `2002:7f00:1::` (6to4-wrapped 127.0.0.1)
    counts as global.
    """
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
        elif ip.teredo is not None:
            server, client = ip.teredo
            return _public_ip(server) and _public_ip(client)
    if ip.version == 4 and ip in ipaddress.IPv4Network('192.0.0.0/24'):
        return False
    return ip.is_global


def _public_address(sock: socket.socket, address):
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return address
    if not isinstance(address, tuple) or len(address) < 2:
        raise OSError("Network destination is invalid")
    host, port = address[:2]
    try:
        ip = ipaddress.ip_address(host)
        if not _public_ip(ip):
            if ip.is_loopback and _loopback_allowed(port):
                return address
            raise OSError("Local network destinations are not allowed")
        return address
    except ValueError:
        pass

    results = socket.getaddrinfo(host, port, sock.family, sock.type, sock.proto)
    if not results:
        raise OSError("Network destination could not be resolved")
    ips = [ipaddress.ip_address(result[4][0]) for result in results]
    if all(ip.is_loopback for ip in ips) and _loopback_allowed(port):
        return results[0][4]
    if any(not _public_ip(ip) for ip in ips):
        raise OSError("Local network destinations are not allowed")
    return results[0][4]


def _guard_async_connect(original):
    async def guarded_sock_connect(loop, sock, address):
        return await original(loop, sock, _public_address(sock, address))

    return guarded_sock_connect


def install(allowed_loopback_ports: "tuple[int, ...] | list[int] | None" = None) -> None:
    global _installed, _allowed_loopback_ports
    if _installed:
        return
    _allowed_loopback_ports = frozenset(allowed_loopback_ports or ())

    def guarded_connect(sock, address):
        return _original_connect(sock, _public_address(sock, address))

    def guarded_connect_ex(sock, address):
        return _original_connect_ex(sock, _public_address(sock, address))

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    # Python's Windows socketpair fallback uses socket.connect() to reach its
    # own ephemeral loopback listener. Keep that private IPC working without
    # allowing any arbitrary local destination through guarded_connect().
    # Python 3.10+ defines the fallback directly as `socket.socketpair` (it is
    # no longer an alias of `_fallback_socketpair`), so detect the pure-Python
    # implementation through its module instead of its identity.
    fallback_socketpair = getattr(socket, "_fallback_socketpair", None)
    pure_python_socketpair = (
        (fallback_socketpair is not None and socket.socketpair is fallback_socketpair)
        or getattr(socket.socketpair, "__module__", None) == "socket"
    )
    if pure_python_socketpair:
        socket.socketpair = _internal_socketpair
    # Windows Proactor connects through ConnectEx instead of socket.connect(),
    # so guard the event loop's destination before it reaches that API.
    if sys.platform == "win32":
        from asyncio.proactor_events import BaseProactorEventLoop

        BaseProactorEventLoop.sock_connect = _guard_async_connect(
            BaseProactorEventLoop.sock_connect
        )
    _installed = True
