/* ── Ableton RC Surface — Mapping Starter Templates ────────────── */

window.MappingTemplates = {
  'dj-controller': {
    name: 'DJ Controller',
    description: '2 tracks with Volume, Pan and Mute controls.',
    mappings: {
      'fader-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Track 1 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-2': [{ type: 'mixer_volume', trackIndex: 1, label: 'Track 2 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-1': [{ type: 'mixer_pan', trackIndex: 0, label: 'Track 1 Pan', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-2': [{ type: 'mixer_pan', trackIndex: 1, label: 'Track 2 Pan', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-1': [{ type: 'track_mute', trackIndex: 0, label: 'Track 1 Mute', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-2': [{ type: 'track_mute', trackIndex: 1, label: 'Track 2 Mute', outMin: 0, outMax: 1, curve: 'linear' }]
    }
  },
  'mixer-6': {
    name: '6-Track Mixer',
    description: '6 tracks with Volume faders; first 4 tracks also get Mute toggles.',
    mappings: {
      'fader-1': [{ type: 'mixer_volume', trackIndex: 0, label: 'Track 1 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-2': [{ type: 'mixer_volume', trackIndex: 1, label: 'Track 2 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-3': [{ type: 'mixer_volume', trackIndex: 2, label: 'Track 3 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-4': [{ type: 'mixer_volume', trackIndex: 3, label: 'Track 4 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-5': [{ type: 'mixer_volume', trackIndex: 4, label: 'Track 5 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'fader-6': [{ type: 'mixer_volume', trackIndex: 5, label: 'Track 6 Vol', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-1': [{ type: 'track_mute', trackIndex: 0, label: 'Track 1 Mute', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-2': [{ type: 'track_mute', trackIndex: 1, label: 'Track 2 Mute', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-3': [{ type: 'track_mute', trackIndex: 2, label: 'Track 3 Mute', outMin: 0, outMax: 1, curve: 'linear' }],
      'toggle-4': [{ type: 'track_mute', trackIndex: 3, label: 'Track 4 Mute', outMin: 0, outMax: 1, curve: 'linear' }]
    }
  },
  'instrument-macro': {
    name: 'Instrument Macros & Solos',
    description: '6 knobs mapped to Device 1 parameters, and 4 solo buttons.',
    mappings: {
      'knob-1': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 1, label: 'Macro 1', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-2': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 2, label: 'Macro 2', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-3': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 3, label: 'Macro 3', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-4': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 4, label: 'Macro 4', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-5': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 5, label: 'Macro 5', outMin: 0, outMax: 1, curve: 'linear' }],
      'knob-6': [{ type: 'device_param', trackIndex: 0, deviceIndex: 0, paramIndex: 6, label: 'Macro 6', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-1': [{ type: 'track_solo', trackIndex: 0, label: 'Track 1 Solo', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-2': [{ type: 'track_solo', trackIndex: 1, label: 'Track 2 Solo', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-3': [{ type: 'track_solo', trackIndex: 2, label: 'Track 3 Solo', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-4': [{ type: 'track_solo', trackIndex: 3, label: 'Track 4 Solo', outMin: 0, outMax: 1, curve: 'linear' }]
    }
  },
  'performance': {
    name: 'Performance Sends',
    description: 'XY Pads controlling sends 1 and 2 of tracks 1 and 2, plus 4 record arms.',
    mappings: {
      'xy-1.x': [{ type: 'mixer_send', trackIndex: 0, sendIndex: 0, label: 'Track 1 Send A', outMin: 0, outMax: 1, curve: 'linear' }],
      'xy-1.y': [{ type: 'mixer_send', trackIndex: 0, sendIndex: 1, label: 'Track 1 Send B', outMin: 0, outMax: 1, curve: 'linear' }],
      'xy-2.x': [{ type: 'mixer_send', trackIndex: 1, sendIndex: 0, label: 'Track 2 Send A', outMin: 0, outMax: 1, curve: 'linear' }],
      'xy-2.y': [{ type: 'mixer_send', trackIndex: 1, sendIndex: 1, label: 'Track 2 Send B', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-1': [{ type: 'track_arm', trackIndex: 0, label: 'Track 1 Arm', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-2': [{ type: 'track_arm', trackIndex: 1, label: 'Track 2 Arm', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-3': [{ type: 'track_arm', trackIndex: 2, label: 'Track 3 Arm', outMin: 0, outMax: 1, curve: 'linear' }],
      'button-4': [{ type: 'track_arm', trackIndex: 3, label: 'Track 4 Arm', outMin: 0, outMax: 1, curve: 'linear' }]
    }
  }
};
