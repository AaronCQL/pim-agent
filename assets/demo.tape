# Run at repo root to generate: vhs ./assets/demo.tape
# Docs: https://github.com/charmbracelet/vhs

Output assets/demo.gif

Set Shell "bash"
Set FontFamily "UbuntuMono Nerd Font Mono"
Set FontSize 22
Set Width 1200
Set Height 800
Set Padding 0
Set WindowBar "Colorful"
Set Theme "Dracula"
Set PlaybackSpeed 2

Sleep 250ms
Type "pim" 
Sleep 250ms
Enter
Sleep 1500ms

Type@30ms "Research about Pi from the web and Pim from this codebase, then tell me as concisely as possible what Pim is."
Sleep 250ms
Enter
Sleep 30s
