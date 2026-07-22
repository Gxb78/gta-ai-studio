param(
    [switch]$ListVoices,
    [string]$TextPath,
    [string]$OutputPath,
    [string]$VoiceId,
    [ValidateRange(-4, 4)]
    [int]$Rate = 0
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Speech

$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($ListVoices) {
        $voices = @($synthesizer.GetInstalledVoices() | ForEach-Object {
            [pscustomobject]@{
                id = $_.VoiceInfo.Name
                name = $_.VoiceInfo.Name
                culture = $_.VoiceInfo.Culture.Name
                gender = $_.VoiceInfo.Gender.ToString().ToLowerInvariant()
            }
        })
        [Console]::Out.WriteLine(($voices | ConvertTo-Json -Compress))
        exit 0
    }

    if (-not $TextPath -or -not (Test-Path -LiteralPath $TextPath -PathType Leaf)) {
        throw "TextPath must reference an existing file."
    }
    if (-not $OutputPath) {
        throw "OutputPath is required."
    }
    if ($VoiceId) {
        $synthesizer.SelectVoice($VoiceId)
    }
    $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
    if (-not $text.Trim()) {
        throw "Narration text is empty."
    }
    $synthesizer.Rate = $Rate
    $synthesizer.Volume = 100
    $synthesizer.SetOutputToWaveFile($OutputPath)
    $synthesizer.Speak($text)
    $synthesizer.SetOutputToNull()
}
finally {
    $synthesizer.Dispose()
}
