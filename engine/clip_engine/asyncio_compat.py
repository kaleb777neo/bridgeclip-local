"""Python 3.10 compatibility: `asyncio.timeout` landed in 3.11.

The service modules use the 3.11 timeout context manager. Importing this
module installs a faithful subset on 3.10 (cancel the enclosing task after
the delay, surface TimeoutError at the await point); on 3.11+ it is a no-op.
"""
import asyncio


if not hasattr(asyncio, 'timeout'):
    class _Timeout:
        """Minimal backport of asyncio.timeout for `async with` blocks."""

        def __init__(self, delay):
            self._delay = delay
            self._task = None
            self._handle = None
            self._expired = False

        def _expire(self):
            self._expired = True
            self._task.cancel()

        async def __aenter__(self):
            self._task = asyncio.current_task()
            if self._task is None:
                raise RuntimeError('asyncio.timeout called outside a task')
            self._handle = asyncio.get_running_loop().call_later(self._delay, self._expire)
            return self

        async def __aexit__(self, exc_type, exc, tb):
            if self._handle is not None:
                self._handle.cancel()
            if self._expired and exc_type is not None and issubclass(exc_type, asyncio.CancelledError):
                # Our own deadline fired; an external cancel leaves _expired False.
                self._expired = False
                raise TimeoutError from None
            return False

    asyncio.timeout = _Timeout
