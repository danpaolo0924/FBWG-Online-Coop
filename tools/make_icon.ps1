# Draws the installer icon (red flame head + blue water head on dark stone) and writes a multi-size .ico.
param([string]$Out = (Join-Path (Split-Path -Parent $PSScriptRoot) 'installer\icon.ico'))
Add-Type -AssemblyName System.Drawing

function Draw-Icon([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $f = $s / 256.0
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 48 * $f; $w = $s - 1
    $bg.AddArc(0, 0, $r, $r, 180, 90); $bg.AddArc($w - $r, 0, $r, $r, 270, 90)
    $bg.AddArc($w - $r, $w - $r, $r, $r, 0, 90); $bg.AddArc(0, $w - $r, $r, $r, 90, 90); $bg.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 58, 48, 24))), $bg)
    $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 201, 153, 47)), ([Math]::Max(1, 10 * $f))), $bg)
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 235, 64, 30))
    $orange = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 170, 40))
    $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 40, 150, 240))
    $cyan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 140, 220, 255))
    # Fireboy: flame (triangle) over a round head
    $flame = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF (40 * $f), (120 * $f)),
        (New-Object System.Drawing.PointF (78 * $f), (30 * $f)),
        (New-Object System.Drawing.PointF (116 * $f), (120 * $f)))
    $g.FillPolygon($orange, $flame)
    $g.FillEllipse($red, 34 * $f, 96 * $f, 88 * $f, 88 * $f)
    # Watergirl: drop (circle + triangle) head
    $drop = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF (140 * $f), (130 * $f)),
        (New-Object System.Drawing.PointF (178 * $f), (40 * $f)),
        (New-Object System.Drawing.PointF (216 * $f), (130 * $f)))
    $g.FillPolygon($cyan, $drop)
    $g.FillEllipse($blue, 134 * $f, 96 * $f, 88 * $f, 88 * $f)
    # shoulders
    $g.FillPie($red, 22 * $f, 184 * $f, 112 * $f, 112 * $f, 180, 180)
    $g.FillPie($blue, 122 * $f, 184 * $f, 112 * $f, 112 * $f, 180, 180)
    $g.Dispose()
    return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
    $ms = New-Object System.IO.MemoryStream
    (Draw-Icon $s).Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    , $ms.ToArray()
}
$fs = [System.IO.File]::Create($Out); $bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $d = $pngs[$i]
    $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$d.Length); $bw.Write([uint32]$offset)
    $offset += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Close()
(Draw-Icon 256).Save(($Out -replace '\.ico$', '_preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
"wrote $Out"
