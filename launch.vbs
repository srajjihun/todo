Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Siraj\todo"
sh.Run "cmd /c node ""C:\Siraj\todo\diag.js"" & ""C:\Siraj\todo\node_modules\electron\dist\electron.exe"" ""C:\Siraj\todo"" >> ""C:\Siraj\todo\run.log"" 2>&1", 0, False
