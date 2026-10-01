# 读出 Windows 原生菜单（类名 #32768）当前实际显示的菜单项文本。
#
# 背景：顶栏「文件/编辑/视图/帮助」是 Electron `Menu.popup` 弹出的原生 Win32 菜单，
# 不在 renderer DOM 里（CDP 读不到）；截图 OCR 已被证实会编造文本
# （见记忆 cdp-dom-forensics-over-ocr）。UIA/MSAA 桥在菜单窗上返回 0 个后代，
# 同样不可用。
#
# 本脚本走纯 Win32：菜单弹窗是类名 #32768 的窗口，对它发 MN_GETHMENU(0x01E1)
# 即可取回真实 HMENU，再用 GetMenuItemCount / GetMenuStringW 逐项读出用户看到的
# 那一串文本。读到的是渲染后的真实结果，不存在猜测或推断。
#
# 用法：先真实点击顶栏菜单按钮弹出菜单，再在菜单存续期间跑本脚本（菜单一关就报错）。
# 退出码 0 = 读到菜单；1 = 没读到（菜单未弹出 / 已关闭 / 该弹窗不持有 HMENU）。

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeMenuReader {
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMenuItemCount(IntPtr hMenu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMenuStringW(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);
    [DllImport("user32.dll")]
    private static extern uint GetMenuItemID(IntPtr hMenu, int nPos);
    [DllImport("user32.dll")]
    private static extern uint GetMenuState(IntPtr hMenu, uint uId, uint uFlags);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private const uint MN_GETHMENU = 0x01E1;
    private const uint MF_BYPOSITION = 0x00000400;
    private const uint MF_SEPARATOR = 0x00000800;
    private const uint MF_DISABLED = 0x00000003;
    private const uint MF_CHECKED = 0x00000008;

    public class Row {
        public int Index;
        public bool Separator;
        public bool Disabled;
        public bool Checked;
        public string Text;
    }

    public class Popup {
        public IntPtr Handle;
        public string OwnerTitle;
        public string ClassName;
        public List<Row> Rows;
    }

    public static List<Popup> Read() {
        var results = new List<Popup>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, cls.Capacity);
            if (cls.ToString() != "#32768") return true;
            var hMenu = SendMessageW(hWnd, MN_GETHMENU, IntPtr.Zero, IntPtr.Zero);
            if (hMenu == IntPtr.Zero) return true;
            var ownerText = new StringBuilder(256);
            GetWindowTextW(hWnd, ownerText, ownerText.Capacity);
            var owner = ownerText.ToString();
            var popup = new Popup { Handle = hWnd, OwnerTitle = owner, ClassName = cls.ToString(), Rows = new List<Row>() };
            var count = GetMenuItemCount(hMenu);
            for (var i = 0; i < count; i++) {
                var buffer = new StringBuilder(512);
                var length = GetMenuStringW(hMenu, (uint)i, buffer, buffer.Capacity, MF_BYPOSITION);
                var state = GetMenuState(hMenu, (uint)i, MF_BYPOSITION);
                popup.Rows.Add(new Row {
                    Index = i,
                    Separator = (state & MF_SEPARATOR) != 0,
                    Disabled = (state & MF_DISABLED) == MF_DISABLED,
                    Checked = (state & MF_CHECKED) != 0,
                    Text = length > 0 ? buffer.ToString() : ""
                });
            }
            results.Add(popup);
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@

$popups = [NativeMenuReader]::Read()
if ($popups.Count -eq 0) {
    Write-Error 'NO_POPUP_MENU: 没有可读的原生菜单弹窗（菜单未弹出、已关闭，或该弹窗不持有 HMENU）'
    exit 1
}

Write-Output ('POPUP_COUNT ' + $popups.Count)
foreach ($popup in $popups) {
    Write-Output ('--- POPUP hwnd=' + $popup.Handle + ' class=' + $popup.ClassName + ' owner=[' + $popup.OwnerTitle + ']')
    Write-Output ('ITEM_COUNT ' + $popup.Rows.Count)
    foreach ($row in $popup.Rows) {
        if ($row.Separator) {
            Write-Output ('ITEM ' + $row.Index + ' | --- | ---')
            continue
        }
        $flags = @()
        if ($row.Disabled) { $flags += 'disabled' }
        if ($row.Checked) { $flags += 'checked' }
        Write-Output ('ITEM ' + $row.Index + ' | ' + ($flags -join ',') + ' | [' + $row.Text + ']')
    }
}
exit 0
