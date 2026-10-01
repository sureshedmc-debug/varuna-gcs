' VARUNA GCS silent launcher
' Runs launch-varuna.ps1 without showing any terminal window.
' This file is what the desktop shortcut points to.

Dim shell
Set shell = CreateObject("WScript.Shell")

' Build the absolute path to the PowerShell script next to this file
Dim scriptDir
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
Dim ps1Path
ps1Path = scriptDir & "launch-varuna.ps1"

' -ExecutionPolicy Bypass  : runs without needing the user to change PS policy
' -WindowStyle Hidden      : no terminal window appears
' -NonInteractive          : never pauses waiting for input
shell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File """ & ps1Path & """", 0, False

Set shell = Nothing
