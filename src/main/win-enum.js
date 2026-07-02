'use strict';
/* Enumerates top-level application windows (z-order, physical px bounds) via
   a persistent PowerShell helper — Electron has no API for other apps'
   window rectangles. Modeled on gdi-capture.js: spawned once, kept warm, so a
   listing costs ~50-150 ms instead of a full PowerShell start-up. Used by the
   snip overlay to snap the selection to the window under the cursor. */
const { spawn } = require('node:child_process');

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
# write through an explicit UTF-8 stream: setting [Console]::OutputEncoding
# throws "handle is invalid" when spawned without a console
$Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$Out.AutoFlush = $true
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int sz);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  public struct RECT { public int L, T, R, B; }
  public static void Init() { SetProcessDPIAware(); }
  public static string ListWindows() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked = 0;
      DwmGetWindowAttribute(h, 14, out cloaked, 4); // DWMWA_CLOAKED: UWP shells parked off-screen
      if (cloaked != 0) return true;
      RECT r;
      // extended frame bounds: the visible rect, without invisible resize borders
      if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) return true;
      if (r.R - r.L < 64 || r.B - r.T < 48) return true;
      var t = new StringBuilder(260);
      GetWindowText(h, t, 260);
      if (t.Length == 0) return true;
      var c = new StringBuilder(64);
      GetClassName(h, c, 64);
      sb.Append((long)h).Append('|').Append(c).Append('|')
        .Append(r.L).Append('|').Append(r.T).Append('|')
        .Append(r.R - r.L).Append('|').Append(r.B - r.T).Append('|')
        .Append(t.ToString().Replace("|", " ").Replace("\\n", " ")).Append('\\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
'@
[WinEnum]::Init()
$Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'EXIT') { break }
  try {
    $Out.Write([WinEnum]::ListWindows())
    $Out.WriteLine('END')
  } catch {
    $Out.WriteLine('END')
  }
}
`.trim();

let helper = null;
let readyPromise = null;
let queue = Promise.resolve();

function ensureHelper() {
  if (helper && helper.exitCode === null && readyPromise) return readyPromise;
  // -EncodedCommand: the script is full of quotes (C# strings), which argv
  // quoting would mangle — base64 sidesteps that entirely
  helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  helper.on('exit', () => { helper = null; readyPromise = null; });
  // surface Add-Type/compile failures instead of a silent timeout. Redirected
  // stderr is CLIXML-wrapped: skip the header and benign progress records,
  // print anything that looks like an actual error
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    const text = String(chunk).replace('#< CLIXML', '').trim();
    if (text && (!text.startsWith('<Objs') || text.includes('S="Error"'))) {
      console.error('win-enum helper:', text.slice(0, 600));
    }
  });

  // producer/consumer line queue: the whole window list arrives as one chunk
  // of many lines, so undelivered lines must be buffered, not dropped
  let buffer = '';
  const pendingLines = [];
  const lineWaiters = [];
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (lineWaiters.length) lineWaiters.shift()(line);
      else pendingLines.push(line);
    }
  });
  helper.nextLine = (timeoutMs = 5000) => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift());
    return new Promise((resolve, reject) => {
      lineWaiters.push(resolve);
      setTimeout(() => reject(new Error('window enumeration timed out')), timeoutMs).unref();
    });
  };

  // the first-ever Add-Type compile can take several seconds on a cold
  // machine — give READY plenty of time, and if it still fails, kill the
  // process so the next call gets a fresh start instead of a cached rejection
  const h = helper;
  readyPromise = h.nextLine(15000).then((line) => {
    if (line !== 'READY') throw new Error(`unexpected helper greeting: ${line}`);
  }).catch((err) => {
    try { h.kill(); } catch {}
    if (helper === h) { helper = null; readyPromise = null; }
    throw err;
  });
  return readyPromise;
}

/* -> [{ hwnd, className, rect: {x, y, width, height}, title }] in z-order
   (topmost first), physical pixels. */
function listWindows() {
  queue = queue.catch(() => {}).then(async () => {
    await ensureHelper();
    helper.stdin.write('LIST\n');
    const windows = [];
    for (;;) {
      const line = await helper.nextLine();
      if (line === 'END') break;
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 7) continue;
      const [hwnd, className, x, y, w, h] = parts;
      windows.push({
        hwnd,
        className,
        rect: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
        title: parts.slice(6).join('|'),
      });
    }
    return windows;
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

module.exports = { listWindows, warmUp, dispose, HELPER_SCRIPT };
