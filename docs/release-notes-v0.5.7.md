# Ableton RC Surface v0.5.7 — Release Notes

This release introduces major new features that turn any mobile phone browser into a low-latency controller and sensor modulator for Ableton Live, featuring in-browser parameter mapping, MIDI note triggering, and deep synchronization.

## Key Additions

- **Mobile MAP Mode**: Phone users can bind controls (pads, knobs, faders, XY axes) directly to Live parameters from the phone screen without opening the Ableton panel interface.
- **Hierarchical Mobile Target Picker**: Live parameters are dynamically listed in a structured hierarchy (Song/Master, normal tracks, return tracks, devices, and parameters) for clean, fast selection.
- **Mobile MIDI Trigger Notes**: Trigger MIDI notes on a selected MIDI track using the included `RC-Midi-Receiver.amxd` Max for Live device, featuring real-time pitch, octave, and velocity editing.
- **Performance UTIL Column**: The PERF tab now exposes snapshot slots `1`-`4`, `CAP` (capture), and `OFF` for fast performance actions.
- **XY Axis Mapping**: XY pads now support independent mappings for both X and Y axes in the mobile mapping editor.
- **Visual Metronome & Transport Overlay**: Flashes the header metronome button in sync with Ableton's beat, and features a full-screen transport control overlay (`TRN` button) to control playhead, locators, and search lists.
- **Response Curve Preview**: Visual feedback on the mobile mapping editor featuring a 2D curve canvas and real-time moving dot.

## Improvements & Fixes

- **Performance OFF Reset**: Resets LFOs, stutters, pads, centered XY pads, and active morphs without touching mixer controls or transport.
- **Modulator Transition Morphing**: Modulators and morphs now drive mapped Live values during the morph transition instead of jumping directly to the final state.
- **Stable Sync & LFOs**: Fallback to continuous LFO when transport is stopped to prevent freeze, and smoother sync beats.
- **Conflict Picker**: Overlay conflicts resolve cleanly, and duplicate note trigger binds are checked.

## Installation & Setup

1. Double-click `Ableton-RC-Surface-0.5.7.ablx` to install.
2. *(Optional)*: Copy `RC-Midi-Receiver.amxd` into your Ableton **User Library** (`User Library/Presets/MIDI Effects/Max MIDI Effect/`).
3. *(Optional)*: Download and install [AbletonOSC](https://github.com/ideoforms/AbletonOSC) in your `MIDI Remote Scripts` directory to activate Deep Sync features.
