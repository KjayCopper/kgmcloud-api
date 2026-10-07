# KGMELS — Vehicle Config Setup Guide

This guide explains how to set up a vehicle config for the KGM ELS
(Emergency Lighting System).

It is written for people who have **never coded before**. You do not need
any programming knowledge to use it. The config file is just a list of
**settings** — think of it like a form you fill in for the car.

---

## 1. What is a "vehicle config"?

A vehicle config is **a set of instructions that tells the ELS system
which lights the car has, what colours they should flash, and what
happens when you press each button**.

It is a single file — like a settings sheet for that car.

Every car uses a config. One config can be shared by many cars (that is
what the `Demo` config does), or each car can have its own.

The config lives in a folder called **Configs** and always starts with
`return {`. If you see a config file, the font/formatting you will spot:

```lua
return {
    -- your settings go in here
}
```

The `return {` just means "here is the sheet of settings". You never
need to think about it.

---

## 2. Where everything lives (the map of the system)

Imagine the KGM ELS system is a box of parts. This is what is inside:

```
ServerScriptService
└── KGMELS                        <- the whole box
    ├── Config.lua                <- your license key (see step 3)
    ├── Configs                   <- all the car config "sheets" live here
    │   └── Demo.lua              <- the example sheet you copy
    └── Core                      <- the engine (DO NOT TOUCH)
        └── (lots of files)
```

**The golden rule: only ever change files in the `Configs` folder**
(and the license key in `Config.lua`). The `Core` folder is the engine —
do not touch it. If something is wrong, it is almost always in the config.

In Roblox Studio, these files are called **ModuleScripts**. A ModuleScript
and a `.lua` file are the same thing, just stored differently. Everything
in this guide that says "the Demo file" means the `Demo` ModuleScript in
the `Configs` folder.

---

## 3. Before anything works: the license key

KGMELS will not start at all without a valid license.

1. Open `KGMELS/Config.lua`.
2. You will see:

```lua
return {
	LicenseKey = "",
}
```

3. Paste your license key between the two quote marks, like this:

```lua
return {
	LicenseKey = "kgm-ABCD1234-YOUR-KEY",
}
```

4. Make sure HTTP requests are turned on in your game:
   **Game Settings → Security → Allow HTTP Requests**.
   Without this, the license check always fails and nothing loads.

If the license is missing or wrong, the system stays completely switched
off. This is on purpose — the lights will not work without it.

---

## 4. How a car finds its config

Each car has a small script inside it (the **ELS plugin**). That script
has one tiny setting on it that says which config to use.

There are two ways to set it (pick one, they are listed in order of
which the system checks first):

- A **StringValue** named `ConfigName` inside the plugin. The Value is
  the name of your config (for example `Demo`).
- A **Config attribute** on the plugin. Same thing, a name like `Demo`.

For example, if the plugin has `ConfigName = "Demo"`, the car uses the
`Demo` config from the Configs folder. Change the text to switch which
config the car uses.

> Tip: the name must exactly match the ModuleScript name in the Configs
> folder, including capital letters. `demo` and `Demo` are different.

---

## 5. Making your own config (your first car)

The easiest way to make a config is to **copy the Demo one** and rename
it. In Studio:

1. Right-click the `Demo` ModuleScript in the `Configs` folder.
2. Select **Duplicate**.
3. Rename the copy to something like `MyCar` (no spaces).
4. Open it and start editing the settings below.
5. Set your car's plugin `ConfigName` to `MyCar`.

Now let's look at each part of the sheet, one by one.

---

## 6. The settings, explained in plain English

### 6.1 Colors — your paint pots

Colours are given **names** so you only type a colour once and reuse the
name everywhere.

```lua
Colors = {
    Primary   = "#006eff",   -- a bright blue
    Secondary = "#FF0000",   -- red
    White     = "#FFFFFF",   -- white
    Amber     = "#FFAA00",   -- amber/orange
    AirOrange = "#FFBF00",   -- an extra one someone added
},
```

- `Primary` is the main emergency colour (usually blue).
- `Secondary` is the second colour (usually red).
- `White` and `Amber` are for grilles, wigwags, etc.

**US-style cars (red AND blue) can have two primary colours.** If your
car is US spec, add `PrimaryA` and `PrimaryB`. The V2V on-scene show
(Section 10) flashes one side in `PrimaryA` and the other in
`PrimaryB`. Cars that only have `Primary` still work fine — the system
just uses `Primary` for both sides when `PrimaryA`/`PrimaryB` are missing.

The `#RRGGBB` part is a hex code — it's just how computers write colours.
You can use a free "colour picker" website to find a code.

When a pattern below says `Color = "Primary"`, it means "use the blue
from the Colors list".

> You can add as many colours as you like. Give them a name on the left
> and a hex code on the right, separated by `=`.

### 6.2 What is a "light path"? (super important)

Every light in the car lives inside a folder called **Lightbar**. Inside
it there are more folders. A **light path** is the "address" of a light —
which folders to walk through to find it.

Path examples from the Demo config:

| Path in the config          | Where it points in the car          |
| --------------------------- | ----------------------------------- |
| `G1`                        | Lightbar → Primary → G1             |
| `G2`                        | Lightbar → Primary → G2             |
| `Primary.G1.Front`          | Lightbar → Primary → G1 → Front     |
| `Primary.G1.Side`           | Lightbar → Primary → G1 → Side      |
| `Secondary.Aux1`            | Lightbar → Secondary → Aux1         |
| `Extras.AirBeacon`          | Lightbar → Extras → AirBeacon       |

The dots (`.`) mean "then go into this folder".

So `Primary.G1.Front` is read as:
> "In the Lightbar, go into **Primary**, then into **G1**, then into
> **Front**."

**You must look at your own car's Lightbar folder and type the paths to
match the folder names exactly.** If the path doesn't exist, the car
just prints a warning and skips that light — it won't crash, but that
light won't turn on.

### 6.3 Patterns — the heart of it all

Patterns are the actual light shows. Each entry is named, and that name
is what you use in buttons and rules.

The Demo sheet has these patterns: `Primary`, `Secondary`, `OnScene`,
`Grille`, `Gatso`, `Rotator`, `TrafficAdvisor`, `Front`, `Side`, `Back`,
`AirBeacon`, `SecAux`, `WigWag`, `WigWagFade`.

There are several **kinds** of pattern. Here they are one by one.

#### Kind 1: Quick flash (the most common)

This is a list of steps. Each step says "flash this light this many
times". They run in order, one after the other, round and round.

```lua
Primary = {
    {
        Light   = "G1",       -- which light (see light paths)
        Color   = "Primary",  -- which colour from the Colors list
        Flashes = 3,          -- how many times it flashes
        OnTime  = 0.06,       -- seconds it stays ON  per flash
        OffTime = 0.06,       -- seconds it stays OFF per flash
    },
    {
        Light   = "G2",
        Color   = "Primary",
        Flashes = 3,
        OnTime  = 0.06,
        OffTime = 0.06,
    },
},
```

Think of `OnTime` and `OffTime` as brightness and pause, in seconds.
Small numbers (0.05–0.1) = fast, snappy flashing. Bigger numbers
(0.3+) = slow, lazy flashing.

The `BlockFlash` setting: leave it alone unless you know what you're
doing. `BlockFlash = false` keeps the plastic light block visible and
only pulses the glow. `true` (the default) makes the whole thing flash.

#### Kind 1b: Empty pattern (a "trigger" button that lights nothing)

If you write a pattern with **nothing inside the braces**, it becomes a
**trigger-only** pattern. Pressing its button doesn't light anything by
itself — it exists so you can hook it up with rules (Section 9).

```lua
Primary = {},
```

Why is that useful? Some cars (like a US car with a **rotating lightbar**
instead of flashing headlights) have no normal "primary flash" to press.
You still want the `J` button to mean "primary on". So you give `Primary`
an empty body, and add rules that start your true patterns (the spinning
dome, etc.) whenever `Primary` turns on and off. See Section 9 for the
full example.

Only the quick-flash kind can be empty. A pattern with a `Mode`
(`Steady`, `Fade`, `Rotating`, ...) always does its own thing.

#### Kind 2: Everything together on one beat

Sometimes you want several lights to flash **at the exact same time**
instead of one after the other. Instead of `Light = "G1"`, give a list:

```lua
{
    Light = { "G1", "G2" },   -- both flash together
    Flashes = 2,
    Color   = "Primary",
    OnTime  = 0.1,
    OffTime = 0.1,
},
```

You can even give the second light its own colour:

```lua
{
    Light = { "G1", { Light = "G2", Color = "Secondary" } },
    Flashes = 2,
    Color   = "Primary",
    OnTime  = 0.1,
    OffTime = 0.1,
},
```

#### Kind 3: Solid on (steady)

The light stays on, bright and still, until you turn it off. Used for
things like the Gatso camera flash or a steady beacon.

```lua
Gatso = {
    Mode  = "Steady",
    Color = "Primary",
},
```

Notice the `Mode = "Steady"` line — that's what tells the system "this
one doesn't flash, keep it solid".

#### Kind 4: Fade (soft on/off, old-style lights)

The light slowly brightens, holds, then slowly goes dark. This is the
crossfade wave used where one light passes to the next.

```lua
MyFade = {
    Mode    = "Fade",
    FadeIn  = 0.35,   -- seconds to fade in
    Hold    = 0.1,    -- seconds at full brightness
    FadeOut = 0.35,   -- seconds to fade out
    Groups  = {
        {
            Color  = "Primary",
            Lights = { "G1", { Path = "Secondary.G1", Color = "Secondary" } },
        },
        {
            Color  = "Primary",
            Lights = { "G2", { Path = "Secondary.G2", Color = "Secondary" } },
        },
    },
},
```

`Groups` are the waves. Group 1 lights up, fades, then group 2 takes
over, and so on.

#### Kind 5: WigWag (this week's special — alternates two sides)

Wigwags alternate **A** side and **B** side — left, right, left, right.
They can be any lights, not just headlights.

```lua
WigWag = {
    Mode    = "Flash",            -- "Flash" = snap on/off (LED)
    Color   = "White",            -- "Fade"  = soft crossfade (halogen)
    A       = { "Primary.G1.Front" },   -- the "left" side
    B       = { "Primary.G2.Front" },   -- the "right" side
    OnTime  = 0.1,                -- seconds each side stays on  (Flash only)
    OffTime = 0.05,               -- gap before switching         (Flash only)
},
```

Each side (`A` / `B`) can hold one path or a list of paths. You can
also give individual lights their own colour:

```lua
WigWagFade = {
    Mode    = "Fade",
    Color   = "White",
    A       = { "Primary.G1.Side" },
    B       = { "Primary.G2.Side" },
    FadeIn  = 0.25,               -- (Fade mode)
    Hold    = 0.1,                -- (Fade mode)
    FadeOut = 0.25,               -- (Fade mode)
},
```

#### Kind 6: Rotating beacon (the spinning dome)

This spins a part that must be named **Rotation** (inside the lightbar).
The part needs a hinge on it. You only set the speed, power and colour:

```lua
Rotator = {
    Mode  = "Rotating",
    Speed = 240,       -- how fast it spins (degrees per second)
    Motor = 10000,     -- how much power (just leave it)
    Color = "Secondary",
    Light = "Rotator", -- where the dome is
},
```

#### Kind 7: Traffic Advisor (the arrow bar)

The bar at the back of the car that tells people to go left or right.
Pressing **Shift + K** cycles: left → right → alternate → off.

```lua
TrafficAdvisor = {
    Mode     = "Expand",   -- "Expand" grows outwards, "Sweep" sweeps
    Color    = "Secondary",
    Interval = 0.2,        -- speed: smaller = faster
},
```

For this to work your lightbar needs a folder called
**Traffic Advisor** (with a space) containing lights named `T1`, `T2`,
`T3`, and so on.

---

## 7. CustomControls — adding your own buttons

By default these buttons are built in:

| Key         | What it does                     |
| ----------- | -------------------------------- |
| `J`         | Toggle Primary on/off            |
| `Shift + J` | Toggle OnScene                   |
| `K`         | Toggle Secondary                 |
| `Shift + K` | Cycle the Traffic Advisor        |
| `H`         | Horn (hold), siren tap, etc.     |

If you want more buttons for your extra patterns (like WigWagFade), add
them here:

```lua
CustomControls = {
    {
        Key      = "S",
        Modifier = "Ctrl",       -- or "Shift", or leave Modifier out
        Pattern  = "Front",
    },
    {
        Key      = "W",
        Modifier = "Ctrl",
        Pattern  = "WigWagFade",
    },
},
```

`Pattern` must be the **name of a pattern** from your Patterns list, with
the capital letters exactly the same.

---

## 8. Horn and Sirens

These are just lists of sounds:

```lua
Horn = {
    {
        SoundId = "rbxassetid://416079906",
    },
},

Sirens = {
    {
        SoundId = "rbxassetid://9334574272",
    },
    {
        SoundId = "rbxassetid://9334595269",
    },
},
```

Each siren listed is one tone. Press **H** while the siren is on to
switch to the next tone in the list. To use a sound, replace the long
number with the ID of your own sound.

---

## 9. Rules — "if this happens, then do that"

Rules connect patterns together automatically. Example from Demo:

```lua
{
    When  = "Primary",   -- when Primary is turned ON
    Do    = "Gatso",     -- also turn on Gatso
    State = true,        -- true = turn it on
},
```

Read as: *"When Primary turns on, also turn on Gatso."*

```lua
{
    When  = "OnScene",   -- when OnScene is turned ON
    Do    = "Primary",   -- ...
    State = false,       -- false = turn it off
},
```

Read as: *"When OnScene turns on, turn Primary off."* It automatically
undoes itself when OnScene turns off — so when OnScene goes off,
Primary isn't stuck off; the rule only applies while OnScene is on.

> `State = true`  → "Do turns on when When turns on".
> `State = false` → "Do turns off when When turns on".

There is one extra, advanced setting called `Restore`:

```lua
{
    When         = "TrafficAdvisor",
    Do           = "Secondary",
    State        = false,
    Restore      = true,   -- put Secondary back when TA turns off
    RestoreDelay = 0,      -- wait this many seconds first
},
```

This is for "pause" behaviour (the TA pauses Secondary, and Secondary
comes back on its own afterwards). You only need it if you want lights
to automatically return after being stopped.

### Using an empty pattern as a trigger

Remember the empty `Primary = {}` pattern from Section 6.3? Here is the
full example that makes it useful. Say `J` should spin a rotating dome:

```lua
Primary = {},   -- press J: this turns "on", but lights nothing

Rules = {
    -- when Primary turns ON, start the dome...
    { When = "Primary", Do = "Rotator", State = true },
    -- ...and when Primary turns OFF, stop the dome again.
    { When = "Primary", Do = "Rotator", State = false },
},
```

Press **J** once → the rules turn the dome on. Press **J** again →
Primary turns off, the rule turns the dome off. Without the
`State = false` line, the dome would keep spinning and never stop.

---

## 10. V2V — syncing cars together (quick version)

If you want all the nearby police cars to flash **in time with each
other**, turn on V2V:

```lua
V2V = {
    Enabled = true,
},
```

With V2V on, pressing **Shift + J** (OnScene) uses a special built-in
on-scene light show, and every V2V car nearby flashes the same segments
on the same beat. Everything else in your config still works, and your
rules still run when OnScene turns on or off.

The built-in show uses these colours from your `Colors` list:

- **Primary side G1** → `PrimaryA`, or just `Primary` if you don't have `PrimaryA`.
- **Primary side G2** → `PrimaryB`, or just `Primary` if you don't have `PrimaryB`.
- **Secondary bar** → `Secondary`.

So for a US red/blue car, set:

```lua
Colors = {
    PrimaryA = "#006eff",   -- G1 side flashes blue
    PrimaryB = "#FF0000",   -- G2 side flashes red
    Primary  = "#006eff",   -- (optional) used everywhere else
    Secondary = "#FFAA00",
},
```

---

## 11. A checklist for making your first full config

1. Duplicate `Demo` and rename it (e.g. `MyCar`).
2. Point your car's plugin `ConfigName` at `MyCar`.
3. Check `Colors` — change them to your department's colours.
4. Go through `Patterns` and change every `Light = "..."` path so it
   matches **your** car's Lightbar folders (Section 6.2).
5. Add any extra patterns you want (WigWag, etc.).
6. Wire up buttons in `CustomControls` and relationships in `Rules`.
7. Test. Fix paths that print warnings.

---

## 12. Common problems (and what they mean)

| Problem                              | What it means and what to do                         |
| ------------------------------------ | ---------------------------------------------------- |
| "Could not resolve light path"       | A `Light` path doesn't match your Lightbar folders. Check the spelling and folder names (Section 6.2). |
| "Invalid colour"                     | A `Color` name in a pattern isn't in your `Colors` list, or the hex code is wrong. |
| "no license" / framework disabled    | License key missing in `Config.lua`, or HTTP requests are off (Section 3). |
| "Rule references missing pattern"    | A rule's `When` or `Do` names a pattern that isn't in your Patterns list. Check the capital letters. |
| "Could not resolve path ... double check the car" | Same as the first row — a path typo. |
| The car never registers              | The car is missing a part named exactly `KGMELS` inside `Body`, or there is no `DriveSeat`. |
| Car uses the wrong config            | The plugin's `ConfigName` / `Config` doesn't match the ModuleScript name. |

---

## 13. Handy glossary (no-brainer words)

- **Config / ModuleScript** — the sheet of settings for a car.
- **Pattern** — one light show (which lights, which colours, how fast).
- **Step** — one small line inside a flash pattern ("flash G1 three times").
- **Light path** — the address of a light inside the Lightbar folder.
- **Color name** — a friendly name (like `Primary`) for a hex colour.
- **Rule** — a connection between two patterns ("when X, do Y").
- **V2V** — cars flashing in sync with each other.
- **Hex code** — a computer way of writing a colour, like `#FF0000`.
- **OnTime / OffTime** — seconds ON and seconds OFF, in that order.
- **Mode** — the "type" of pattern: Flash, Steady, Fade, Rotating, WigWag.

---

That's it. Copy the Demo, rename it, fix the light paths to match your
car, and you're done. If a light doesn't come on, nine times out of ten
it's a path spelling or a folder name in your Lightbar. Good luck!