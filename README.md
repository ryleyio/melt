# melt

Full melt hash control. Terminal-based Puffco controller.

```
 ███╗   ███╗███████╗██╗  ████████╗
 ████╗ ████║██╔════╝██║  ╚══██╔══╝
 ██╔████╔██║█████╗  ██║     ██║
 ██║╚██╔╝██║██╔══╝  ██║     ██║
 ██║ ╚═╝ ██║███████╗███████╗██║
 ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝
```

## Install

```bash
npm install -g @ryleyio/melt
```

## Usage

```bash
melt              # show help
melt status       # battery, temp, dab count
melt profiles     # list heat profiles
melt heat 0       # heat with profile 0
melt stop         # stop heating
melt reset        # fix connection issues
```

## Requirements

- macOS (uses noble for BLE)
- Node.js 18+
- Puffco Proxy (tested on latest firmware)

## Disclaimer

Unofficial tool. Not affiliated with Puffco. Use at your own risk.

<a href="https://buymeacoffee.com/ryleyio" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" 
       alt="Buy Me A Coffee" 
       style="height: 60px !important;width: 217px !important;" >
</a>
