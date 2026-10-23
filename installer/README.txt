FIREBOY & WATERGIRL: THE FOREST TEMPLE - ONLINE CO-OP MOD (v1.1)
================================================================
Modded by Prompt|

Two PCs, two players, over the internet. One plays Fireboy, the other Watergirl.
No port forwarding, VPN or server needed when you use a join code.

INSTALL
-------
1. Close the game.
2. Run "FBWG Online Co-op Installer". It finds the game through Steam
   (or click Browse and pick the folder with FbwgForest.exe:
   Steam > Fireboy & Watergirl > Manage > Browse local files).
3. Click Install. Both players need to install it.

Uninstall: run the installer again and click Uninstall. Steam's
"Verify integrity of game files" also removes the mod. If Steam updates
the game, just run the installer again.

HOW TO PLAY
-----------
1. Start the game. An ONLINE button appears at the top of the menus.
2. Host: ONLINE > "Host a game". A 5-character code appears (e.g. K7QWD).
   "Copy code" puts it on the clipboard - send it to your friend.
3. Friend: ONLINE > type the code > Join.
4. When it says Connected, close the panel. Player 1 (the host) picks a level
   from the level map and both games start it together.
   Player 2 sees the host's map greyed out (with a gold ring on the level the
   host is pointing at) and can't click it. After each level, Player 2's
   screen follows the host back to the map automatically.

The host chooses who plays Fireboy and who plays Watergirl (buttons in the
ONLINE panel). Default: host = Fireboy.

CO-OP SAVES
-----------
Online play uses a co-op save instead of your own progress: unlocked levels,
best times and diamonds you earn together. It is saved after every level, as the
same file on BOTH PCs, so either of you can host it next time.
  - The host picks the save in the ONLINE panel ("Co-op save"), before or after
    the friend joins: the newest save is picked automatically, or choose
    "+ New co-op save" to start fresh from level 1.
  - Your own single-player progress is never changed by online play; it comes
    back as soon as you disconnect.
  - Save files: %LOCALAPPDATA%\FbwgForest\coop_saves\coop_*.json
    (back them up or copy them to another PC if you like).

CONTROLS (each player on their own PC)
  Move / jump ..... Arrow keys OR WASD (both control YOUR character)
  P ............... pause (pauses for both)
  R ............... restart level (both)
  Esc ............. leave level when paused / after game over (both)
Mouse clicks on the in-level buttons (pause, retry, menu) also apply to both.

A small bar at the top of the screen shows your character and the ping.

REQUIREMENTS
- Both players need this same mod version (checked when you connect).
- Both need Steam running (the game itself requires it).

HOW IT WORKS
Both PCs run the full game. During a level they exchange only key presses every
frame (lockstep), with a 4-frame (~67 ms) input delay to hide lag. If your
partner's input is late the game briefly waits ("Waiting for your partner...")
instead of drifting apart. A checksum is compared every second; if the games
ever differ a red DESYNC warning appears - pause, press Esc and start the level again.
Each player keeps their own save/progress.

IF THE CODE WON'T CONNECT
Some strict networks (certain mobile hotspots, corporate networks) block direct
connections. Use Direct IP instead (ONLINE > Direct IP):
  - Host clicks "Host on this port" (default 7777, TCP) and needs that port
    forwarded on their router - or both use a VPN like Radmin VPN / ZeroTier /
    Tailscale and use the VPN IP.
  - Friend enters the host's IP and clicks "Join IP".

WHAT THE INSTALLER CHANGES (inside the game folder)
  resources\app\www\index.html   one line added (original saved as index.html.original)
  resources\app\main.js          two small additions (original saved as main.js.original)
  resources\app\www\js\online\net.js   the mod itself (new)
  fbwg_online_mod.txt, ONLINE CO-OP README.txt   (new)

ADVANCED / TESTING (command line flags for FbwgForest.exe)
  --fbwg-online                 open the ONLINE panel at startup
  --fbwg-hostcode               host with a join code at startup
  --fbwg-joincode=CODE          join a code at startup
  --fbwg-hostip[=PORT]          host Direct IP at startup
  --fbwg-joinip=IP[:PORT]       join Direct IP at startup
  --fbwg-profile=NAME           separate save folder (run two copies on one PC)
Logs: %LOCALAPPDATA%\FbwgForest\fbwg_net_main.log

Join codes use the free public PeerJS signalling server (0.peerjs.com) only to
introduce the two games; gameplay traffic goes directly between the two PCs.
