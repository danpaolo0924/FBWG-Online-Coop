// Fireboy & Watergirl: The Forest Temple Online Co-op - installer / uninstaller
// (WinForms, .NET Framework 4, C# 5). Edits the player's OWN game files; no game files are distributed.
// The mod (net.js) is embedded in the exe as a resource, or read from installer\mod\net.js next to it.
// Command line (for testing):  Installer.exe --install|--uninstall "<game folder>"  (log -> installer_log.txt)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("FBWG Forest Temple Online Co-op Installer")]
[assembly: System.Reflection.AssemblyProduct("Fireboy & Watergirl Forest Temple Online Co-op")]
[assembly: System.Reflection.AssemblyCompany("Prompt|")]
[assembly: System.Reflection.AssemblyCopyright("Modded by Prompt|")]
[assembly: System.Reflection.AssemblyVersion("1.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.1.0.0")]

static class Mod
{
    public const string Version = "1.1";
    public const string Author = "Prompt|";
    public const string Title = "Fireboy & Watergirl Online Co-op";
    public const string AppId = "5084260";
    public const string Exe = "FbwgForest.exe";
    public const string Marker = "fbwg_online_mod.txt";
    public const string Readme = "ONLINE CO-OP README.txt";
    const string ScriptTag = "<script src=\"js/online/net.js\"></script>";

    public static string Here { get { return AppDomain.CurrentDomain.BaseDirectory; } }
    static string App(string dir) { return Path.Combine(dir, @"resources\app"); }
    static string IndexHtml(string dir) { return Path.Combine(App(dir), @"www\index.html"); }
    static string MainJs(string dir) { return Path.Combine(App(dir), "main.js"); }
    static string OnlineDir(string dir) { return Path.Combine(App(dir), @"www\js\online"); }

    static string Resource(string name)
    {
        var local = Path.Combine(Here, @"installer\mod\" + name);
        if (File.Exists(local)) return File.ReadAllText(local);
        using (var res = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (res == null) throw new Exception("This installer is incomplete (missing " + name + "). Download it again.");
            using (var r = new StreamReader(res, Encoding.UTF8)) return r.ReadToEnd();
        }
    }

    public static string FindGameFolder()
    {
        var roots = new List<string>();
        string[] keys = { @"HKEY_CURRENT_USER\Software\Valve\Steam", @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", @"HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam" };
        foreach (var k in keys)
        {
            foreach (var name in new[] { "SteamPath", "InstallPath" })
            {
                var v = Registry.GetValue(k, name, null) as string;
                if (!string.IsNullOrEmpty(v)) roots.Add(v.Replace('/', '\\'));
            }
        }
        var libs = new List<string>(roots);
        foreach (var r in roots)
        {
            var vdf = Path.Combine(r, @"steamapps\libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;
            foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"([^\"]+)\""))
                libs.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
        }
        foreach (var lib in libs)
        {
            try
            {
                var acf = Path.Combine(lib, @"steamapps\appmanifest_" + AppId + ".acf");
                if (File.Exists(acf))
                {
                    var m = Regex.Match(File.ReadAllText(acf), "\"installdir\"\\s+\"([^\"]+)\"");
                    if (m.Success)
                    {
                        var dir = Path.Combine(lib, @"steamapps\common\" + m.Groups[1].Value);
                        if (IsGameFolder(dir)) return dir;
                    }
                }
                // fall back to any folder in the library that holds the game exe
                var common = Path.Combine(lib, @"steamapps\common");
                if (!Directory.Exists(common)) continue;
                foreach (var d in Directory.GetDirectories(common))
                {
                    if (IsGameFolder(d)) return d;
                    foreach (var d2 in Directory.GetDirectories(d)) if (IsGameFolder(d2)) return d2;
                }
            }
            catch { }
        }
        return "";
    }

    public static bool GameRunning() { return Process.GetProcessesByName("FbwgForest").Length > 0; }

    public static bool IsGameFolder(string dir)
    {
        return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, Exe)) && File.Exists(IndexHtml(dir));
    }

    public static string Status(string dir)
    {
        var marker = Path.Combine(dir, Marker);
        return File.Exists(marker) ? "INSTALLED (" + File.ReadAllText(marker).Trim() + ")" : "not installed";
    }

    // ---------- patching (text edits; each one is skipped if already present) ----------
    static string PatchIndex(string html)
    {
        if (html.Contains("js/online/net.js")) return html;
        var tag = "\r\n        <!-- online co-op mod -->\r\n        " + ScriptTag;
        int i = html.IndexOf("<!-- endbuild -->");
        if (i >= 0) return html.Insert(i + "<!-- endbuild -->".Length, tag);
        i = html.IndexOf("data-main=\"js/init.js\"");
        if (i >= 0)
        {
            int end = html.IndexOf("</script>", i);
            if (end >= 0) return html.Insert(end + "</script>".Length, tag);
        }
        i = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (i >= 0) return html.Insert(i, tag.TrimStart() + "\r\n");
        throw new Exception("index.html has an unexpected layout - is this the right game?");
    }

    static string PatchMain(string js, Action<string> log)
    {
        if (!js.Contains("--fbwg-profile="))
        {
            var block =
                "// Online co-op: --fbwg-profile=NAME gives a test instance its own save/localStorage folder,\n" +
                "// so two copies can run side by side on one PC.\n" +
                "const profileArg = process.argv.find(a => a.indexOf('--fbwg-profile=') === 0)\n" +
                "if (profileArg) {\n" +
                "  app.setPath('userData', app.getPath('userData') + '-' + profileArg.split('=')[1].replace(/[^\\w-]/g, ''))\n" +
                "}\n\n";
            var m = Regex.Match(js, @"^(//[^\n]*\n)*let win\b", RegexOptions.Multiline);
            if (m.Success) js = js.Insert(m.Index, block);
            else log("  (note: main.js layout differs; skipped the test-profile option)");
        }
        if (!js.Contains("backgroundThrottling"))
        {
            var m = Regex.Match(js, @"devTools:\s*true,?");
            if (m.Success)
            {
                var ins = m.Value.EndsWith(",") ? "" : ",";
                js = js.Insert(m.Index + m.Length, ins +
                    "\n      // online co-op: keep simulating when the window is in the background\n      backgroundThrottling: false,");
            }
            else log("  (note: main.js layout differs; the game may pause while minimized)");
        }
        return js;
    }

    static void WriteText(string path, string text) { File.WriteAllText(path, text, new UTF8Encoding(false)); }

    // ---------- install ----------
    public static bool Install(string dir, Action<string> log)
    {
        log("Game folder: " + dir);
        string index = IndexHtml(dir), main = MainJs(dir);
        string indexOrig = index + ".original", mainOrig = main + ".original";
        string netJs = Resource("net.js");
        string readme = null;
        try { readme = Resource("README.txt"); } catch { }

        // Always patch from the untouched originals, so reinstalling/updating never stacks edits.
        // If the current files are unmodded (Steam update / verify), they become the new originals.
        if (File.Exists(indexOrig) && !File.ReadAllText(index).Contains("js/online/net.js")) File.Delete(indexOrig);
        if (File.Exists(mainOrig) && File.Exists(main) && !File.ReadAllText(main).Contains("fbwg")) File.Delete(mainOrig);
        if (!File.Exists(indexOrig))
        {
            log("Backing up index.html -> index.html.original");
            File.Copy(index, indexOrig);
        }
        else log("Mod already installed - updating it (originals are kept).");
        if (File.Exists(main) && !File.Exists(mainOrig))
        {
            log("Backing up main.js -> main.js.original");
            File.Copy(main, mainOrig);
        }

        log("Patching index.html...");
        WriteText(index, PatchIndex(File.ReadAllText(indexOrig)));
        if (File.Exists(mainOrig))
        {
            log("Patching main.js...");
            WriteText(main, PatchMain(File.ReadAllText(mainOrig), log));
        }

        log("Copying the mod (www\\js\\online\\net.js)...");
        Directory.CreateDirectory(OnlineDir(dir));
        WriteText(Path.Combine(OnlineDir(dir), "net.js"), netJs);
        if (readme != null) WriteText(Path.Combine(dir, Readme), readme);
        File.WriteAllText(Path.Combine(dir, Marker),
            Title + " mod " + Version + " by " + Author + ", installed " + DateTime.Now.ToString("s"));
        log("");
        log("DONE! " + Title + " " + Version + " is installed.");
        log("Start the game: the ONLINE button is at the top of the menus.");
        return true;
    }

    // ---------- uninstall ----------
    public static bool Uninstall(string dir, Action<string> log)
    {
        log("Game folder: " + dir);
        string index = IndexHtml(dir), main = MainJs(dir);
        bool any = false;
        foreach (var f in new[] { index, main })
        {
            var orig = f + ".original";
            if (!File.Exists(orig)) continue;
            log("Restoring " + Path.GetFileName(f) + "...");
            if (File.Exists(f)) File.Delete(f);
            File.Move(orig, f);
            any = true;
        }
        if (Directory.Exists(OnlineDir(dir))) { Directory.Delete(OnlineDir(dir), true); any = true; }
        foreach (var f in new[] { Marker, Readme })
        {
            var p = Path.Combine(dir, f);
            if (File.Exists(p)) { File.Delete(p); any = true; }
        }
        if (!any)
        {
            log("The mod does not seem to be installed here.");
            log("To be sure the game is original: Steam > Fireboy & Watergirl > Properties > Installed Files > Verify integrity.");
            return false;
        }
        log("");
        log("DONE! The mod is removed and the game is back to the original.");
        return true;
    }
}

class InstallerForm : Form
{
    TextBox pathBox, logBox;
    Button btnInstall, btnUninstall, btnBrowse;

    public InstallerForm(string presetFolder)
    {
        Text = Mod.Title + " " + Mod.Version + " - Installer - modded by " + Mod.Author;
        ClientSize = new Size(624, 432);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 9.5f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var title = new Label { Text = Mod.Title, UseMnemonic = false, Font = new Font("Segoe UI", 16, FontStyle.Bold), Location = new Point(18, 14), AutoSize = true };
        Controls.Add(title);
        Controls.Add(new Label { Text = "modded by " + Mod.Author, Font = new Font("Segoe UI", 10, FontStyle.Italic), ForeColor = Color.FromArgb(200, 70, 30), Location = new Point(20, 46), AutoSize = true });
        Controls.Add(new Label { Text = "Play The Forest Temple with a friend online. Adds an ONLINE button to the menus.", Location = new Point(20, 70), AutoSize = true });
        Controls.Add(new Label { Text = "Fireboy & Watergirl: The Forest Temple game folder:", UseMnemonic = false, Location = new Point(20, 96), AutoSize = true });

        pathBox = new TextBox { Location = new Point(20, 118), Size = new Size(490, 26) };
        Controls.Add(pathBox);
        btnBrowse = new Button { Text = "Browse...", Location = new Point(518, 116), Size = new Size(88, 28) };
        btnBrowse.Click += OnBrowse;
        Controls.Add(btnBrowse);

        btnInstall = new Button { Text = "Install", Font = new Font("Segoe UI", 10, FontStyle.Bold), Location = new Point(20, 154), Size = new Size(140, 36) };
        btnInstall.Click += delegate { Run(true); };
        Controls.Add(btnInstall);
        btnUninstall = new Button { Text = "Uninstall", Location = new Point(170, 154), Size = new Size(110, 36) };
        btnUninstall.Click += delegate { Run(false); };
        Controls.Add(btnUninstall);

        logBox = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font("Consolas", 9), Location = new Point(20, 202), Size = new Size(586, 214) };
        Controls.Add(logBox);

        var found = Mod.IsGameFolder(presetFolder) ? presetFolder : Mod.FindGameFolder();
        pathBox.Text = found;
        if (found != "")
            logBox.Text = "Found the game: " + found + "\r\nMod status: " + Mod.Status(found) +
                "\r\n\r\nClick Install. (index.html and main.js are backed up first; Uninstall restores them.)";
        else
            logBox.Text = "Couldn't find the game automatically.\r\nClick Browse and select the game folder (the one with " + Mod.Exe +
                ").\r\nSteam > Fireboy & Watergirl > Manage > Browse local files.";
        AcceptButton = btnInstall;
    }

    void OnBrowse(object sender, EventArgs e)
    {
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Select the game folder (the one with " + Mod.Exe + ")";
            if (pathBox.Text != "") dlg.SelectedPath = pathBox.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) pathBox.Text = dlg.SelectedPath;
        }
    }

    void Log(string line)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string>(Log), line); return; }
        logBox.AppendText(line + "\r\n");
    }

    void SetBusy(bool busy)
    {
        btnInstall.Enabled = btnUninstall.Enabled = btnBrowse.Enabled = pathBox.Enabled = !busy;
        UseWaitCursor = busy;
    }

    void Run(bool install)
    {
        var dir = pathBox.Text.Trim();
        if (!Mod.IsGameFolder(dir))
        {
            MessageBox.Show(this, "That folder does not contain the game (" + Mod.Exe + "). Use Browse to pick the game folder.", Mod.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (Mod.GameRunning())
        {
            MessageBox.Show(this, "Please close the game first.", Mod.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        logBox.Clear();
        SetBusy(true);
        var worker = new Thread(delegate ()
        {
            bool ok;
            try { ok = install ? Mod.Install(dir, Log) : Mod.Uninstall(dir, Log); }
            catch (UnauthorizedAccessException ex) { Log("ERROR: " + ex.Message); Log("Try running the installer as administrator."); ok = false; }
            catch (Exception ex) { Log("ERROR: " + ex.Message); ok = false; }
            BeginInvoke(new Action(delegate
            {
                SetBusy(false);
                if (ok && install)
                    MessageBox.Show(this, "Installed!\n\nStart the game and click ONLINE at the top of the menu.\n\nModded by " + Mod.Author, Mod.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }));
        });
        worker.IsBackground = true;
        worker.Start();
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length >= 1 && (args[0] == "--install" || args[0] == "--uninstall"))
        {
            // Headless mode for testing; writes installer_log.txt next to the exe.
            var dir = args.Length >= 2 ? args[1] : Mod.FindGameFolder();
            var logPath = Path.Combine(Mod.Here, "installer_log.txt");
            using (var w = new StreamWriter(logPath, false))
            {
                Action<string> log = s => { w.WriteLine(s); w.Flush(); };
                if (!Mod.IsGameFolder(dir)) { log("Game not found in '" + dir + "'"); return 1; }
                if (Mod.GameRunning()) { log("Close the game first."); return 1; }
                try { return (args[0] == "--install" ? Mod.Install(dir, log) : Mod.Uninstall(dir, log)) ? 0 : 1; }
                catch (Exception ex) { log("ERROR: " + ex); return 1; }
            }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // Optional: --folder "<game folder>" pre-fills the folder box (unusual install locations).
        var preset = "";
        if (args.Length >= 2 && args[0] == "--folder") preset = args[1];
        Application.Run(new InstallerForm(preset));
        return 0;
    }
}
