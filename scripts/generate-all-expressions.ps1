# scripts/generate-all-expressions.ps1
Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\SantoshPrajapati-Tec\.gemini\antigravity\brain\bd266af1-4429-4da3-807d-da6a7ade43a0\character_expression_sheet_1793422200149.jpg"
$outDir = "C:\Users\SantoshPrajapati-Tec\.gemini\antigravity\scratch\Reeva\public\img\companion\expressions"

if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$bmp = [System.Drawing.Bitmap]::FromFile($srcPath)
Write-Host "Source dimensions: $($bmp.Width) x $($bmp.Height)"

# Row 1: y = 20, height = 322
# Row 2: y = 398, height = 322
# Column widths: 256
$crops = @(
    @{ Name = "happy";        x = 10;   y = 20;  w = 256; h = 322 },
    @{ Name = "smiling";      x = 282;  y = 20;  w = 256; h = 322 },
    @{ Name = "excited";      x = 555;  y = 20;  w = 256; h = 322 },
    @{ Name = "curious";      x = 828;  y = 20;  w = 256; h = 322 },
    @{ Name = "focused";      x = 1101; y = 20;  w = 256; h = 322 },
    @{ Name = "surprised";    x = 10;   y = 398; w = 256; h = 322 },
    @{ Name = "confused";     x = 282;  y = 398; w = 256; h = 322 },
    @{ Name = "disappointed"; x = 555;  y = 398; w = 256; h = 322 },
    @{ Name = "crying";       x = 828;  y = 398; w = 256; h = 322 },
    @{ Name = "celebrating";  x = 1101; y = 398; w = 256; h = 322 }
)

foreach ($c in $crops) {
    $rect = New-Object System.Drawing.Rectangle($c.x, $c.y, $c.w, $c.h)
    $raw = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)

    $w = $raw.Width
    $h = $raw.Height

    $rawRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $rawData = $raw.LockBits($rawRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $rawBytes = [byte[]]::new($rawData.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($rawData.Scan0, $rawBytes, 0, $rawBytes.Length)
    $raw.UnlockBits($rawData)
    $raw.Dispose()

    # Create 32bpp output bitmap
    $out = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $outData = $out.LockBits($rawRect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $outBytes = [byte[]]::new($outData.Stride * $h)

    # Initialize all pixels as fully opaque
    for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            $p24 = $y * $rawData.Stride + $x * 3
            $p32 = $y * $outData.Stride + $x * 4
            $outBytes[$p32] = $rawBytes[$p24]         # B
            $outBytes[$p32 + 1] = $rawBytes[$p24 + 1] # G
            $outBytes[$p32 + 2] = $rawBytes[$p24 + 2] # R
            $outBytes[$p32 + 3] = 255                 # A
        }
    }

    # BFS from top edge and upper border to erase only exterior background
    $visited = [byte[]]::new($w * $h)
    $queue = [System.Collections.Generic.Queue[int]]::new()

    for ($x = 0; $x -lt $w; $x++) {
        $queue.Enqueue($x) # y = 0
        $visited[$x] = 1
    }
    for ($y = 0; $y -lt [math]::Floor($h * 0.75); $y++) {
        $idxL = $y * $w
        if ($visited[$idxL] -eq 0) { $queue.Enqueue($idxL); $visited[$idxL] = 1 }
        $idxR = $y * $w + ($w - 1)
        if ($visited[$idxR] -eq 0) { $queue.Enqueue($idxR); $visited[$idxR] = 1 }
    }

    while ($queue.Count -gt 0) {
        $curr = $queue.Dequeue()
        $cx = $curr % $w
        $cy = [math]::Floor($curr / $w)

        $p24 = $cy * $rawData.Stride + $cx * 3
        $b = $rawBytes[$p24]
        $g = $rawBytes[$p24 + 1]
        $r = $rawBytes[$p24 + 2]

        $minVal = [math]::Min($r, [math]::Min($g, $b))
        $maxDiff = [math]::Max([math]::Abs($r - $g), [math]::Max([math]::Abs($r - $b), [math]::Abs($g - $b)))

        # Background is neutral white
        if ($minVal -ge 246 -and $maxDiff -le 7) {
            $p32 = $cy * $outData.Stride + $cx * 4
            if ($minVal -ge 251) {
                $outBytes[$p32 + 3] = 0 # Fully transparent
            } else {
                # Feathering at border
                $alpha = [byte][math]::Round((251 - $minVal) / 5.0 * 255)
                $outBytes[$p32 + 3] = $alpha
            }

            # Enqueue neighbors
            if ($cx -gt 0) {
                $n = $curr - 1
                if ($visited[$n] -eq 0) { $visited[$n] = 1; $queue.Enqueue($n) }
            }
            if ($cx -lt $w - 1) {
                $n = $curr + 1
                if ($visited[$n] -eq 0) { $visited[$n] = 1; $queue.Enqueue($n) }
            }
            if ($cy -gt 0) {
                $n = $curr - $w
                if ($visited[$n] -eq 0) { $visited[$n] = 1; $queue.Enqueue($n) }
            }
            if ($cy -lt $h - 1) {
                $n = $curr + $w
                if ($visited[$n] -eq 0) { $visited[$n] = 1; $queue.Enqueue($n) }
            }
        }
    }

    [System.Runtime.InteropServices.Marshal]::Copy($outBytes, 0, $outData.Scan0, $outBytes.Length)
    $out.UnlockBits($outData)

    $destPath = Join-Path $outDir "$($c.Name).png"
    $out.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
    Write-Host "Generated expression sprite: $($c.Name).png ($($w)x$($h))"
}

$bmp.Dispose()
Write-Host "All 10 Visual Novel companion sprites successfully generated and saved!"
