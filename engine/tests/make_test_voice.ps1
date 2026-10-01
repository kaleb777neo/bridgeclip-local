Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices()
Write-Output "INSTALLED VOICES:"
foreach ($v in $voices) { Write-Output ("- " + $v.VoiceInfo.Name + " [" + $v.VoiceInfo.Culture + "]") }

$romanian = $voices | Where-Object { $_.VoiceInfo.Culture -like "ro*" } | Select-Object -First 1
if ($romanian) {
  $synth.SelectVoice($romanian.VoiceInfo.Name)
  $text = "Astazi va arat trei metode simple prin care puteti economisi bani pe facturile lunare. Prima metoda este sa dezconectati aparatele din priza cand nu le folositi, pentru ca acestea consuma energie chiar si in standby. A doua metoda este sa comparati ofertele furnizorilor de energie inainte de a va reinnova contractul, pentru ca diferenta dintre oferte poate fi de pana la doua sute de lei pe an. A treia metoda, poate cea mai importanta, este sa va verificati factura in fiecare luna pentru taxe pe care nu le folositi."
} else {
  $english = $voices | Where-Object { $_.VoiceInfo.Culture -like "en*" } | Select-Object -First 1
  if ($english) { $synth.SelectVoice($english.VoiceInfo.Name) }
  $text = "Today I will show you three simple ways to save money on your monthly bills. The first way is to unplug devices when you are not using them, because they draw power even in standby. The second way is to compare energy provider offers before renewing your contract, because the difference can be up to two hundred a year. The third way, perhaps the most important, is to check your bill every month for services you do not use."
}
$out = "C:\Users\Administrator\Desktop\03_Proiecte\bridgeclip-local\engine\tests\test_speech.wav"
$synth.SetOutputToWaveFile($out)
$synth.Rate = 0
$synth.Speak($text)
$synth.SetOutputToNull()
Write-Output ("WROTE " + $out)
