'use strict';
/* Fallback screen capture via a persistent PowerShell helper using
   System.Drawing CopyFromScreen (GDI BitBlt). Used when Electron's
   desktopCapturer returns empty screen thumbnails, which happens on some
   Windows configurations. The helper is spawned once and kept warm so a
   capture costs ~100-300 ms instead of a full PowerShell start-up. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Native -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Native.Dpi]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'EXIT') { break }
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($line, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [Console]::Out.WriteLine("OK $($vs.X) $($vs.Y) $($vs.Width) $($vs.Height)")
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
`.trim();

let helper = null;
let readyPromise = null;
let queue = Promise.resolve();

function ensureHelper() {
  if (helper && helper.exitCode === null && readyPromise) return readyPromise;
  helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELPER_SCRIPT,
  ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  helper.on('exit', () => { helper = null; readyPromise = null; });

  let buffer = '';
  const lineWaiters = [];
  helper.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line && lineWaiters.length) lineWaiters.shift()(line);
    }
  });
  helper.nextLine = () => new Promise((resolve, reject) => {
    lineWaiters.push(resolve);
    setTimeout(() => reject(new Error('gdi helper timed out')), 15000).unref();
  });

  readyPromise = helper.nextLine().then((line) => {
    if (line !== 'READY') throw new Error(`unexpected helper greeting: ${line}`);
  });
  return readyPromise;
}

/* Captures the whole virtual screen. Resolves to
   { file, x, y, width, height } in physical pixels; caller deletes the file. */
function captureVirtualScreen() {
  queue = queue.catch(() => {}).then(async () => {
    await ensureHelper();
    const file = path.join(os.tmpdir(), `snippit-gdi-${Date.now()}-${process.pid}.png`);
    helper.stdin.write(`${file}\n`);
    const line = await helper.nextLine();
    if (!line.startsWith('OK ')) {
      try { fs.unlinkSync(file); } catch {}
      throw new Error(line.replace(/^ERR\s*/, '') || 'gdi capture failed');
    }
    const [x, y, width, height] = line.slice(3).trim().split(/\s+/).map(Number);
    return { file, x, y, width, height };
  });
  return queue;
}

function warmUp() {
  try { ensureHelper(); } catch {}
}

function dispose() {
  if (helper && helper.exitCode === null) {
    try { helper.stdin.write('EXIT\n'); } catch {}
    const h = helper;
    setTimeout(() => { try { h.kill(); } catch {} }, 500).unref();
  }
  helper = null;
  readyPromise = null;
}

module.exports = { captureVirtualScreen, warmUp, dispose };
