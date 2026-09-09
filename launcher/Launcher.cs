using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class DshPortableLauncher
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private const int SwRestore = 9;

    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Process[] running = Process.GetProcessesByName("DSH Codex Desktop");
        foreach (Process process in running)
        {
            bool belongsToPortableRoot = false;
            try
            {
                string executable = process.MainModule.FileName;
                belongsToPortableRoot = executable.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            }
            catch { }
            if (!belongsToPortableRoot) continue;
            if (process.MainWindowHandle != IntPtr.Zero)
            {
                ShowWindow(process.MainWindowHandle, SwRestore);
                SetForegroundWindow(process.MainWindowHandle);
                return 0;
            }
        }
        foreach (Process process in running)
        {
            bool belongsToPortableRoot = false;
            try { belongsToPortableRoot = process.MainModule.FileName.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
            catch { }
            if (!belongsToPortableRoot) continue;
            MessageBox.Show(
                "DSH Codex Desktop 已在后台运行，但窗口暂不可见。\r\n请从系统托盘图标恢复窗口，或先彻底退出后再启动。",
                "DSH 便携版 3",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return 0;
        }

        string script = Path.Combine(root, "Start-DSH-Portable.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show("缺少 Start-DSH-Portable.ps1，便携版结构不完整。", "DSH 便携版 3", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = "powershell.exe";
        startInfo.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"";
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = false;
        try
        {
            Process child = Process.Start(startInfo);
            if (child == null)
            {
                MessageBox.Show("启动器未能创建 PowerShell 进程，请检查系统 PowerShell 是否可用。", "DSH 便携版 3", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败：" + ex.Message, "DSH 便携版 3", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
