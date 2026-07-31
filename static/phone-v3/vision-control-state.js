/*
 * Copyright (c) 2025-2026 Gustavo Pinto
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
(function (global) {
  'use strict';

  const DETECTORS = ['open', 'fist', 'pinch', 'victory', 'fingers'];
  const SLOT_COUNT = 3;

  function cleanName(value) {
    return typeof value === 'string' ? value.trim().slice(0, 32) : '';
  }

  function normalizeVisionGestureTemplates(templates) {
    if (!Array.isArray(templates)) return [];
    return templates.slice(0, SLOT_COUNT).map((template) => ({
      ...template,
      samples: Array.isArray(template?.samples) ? template.samples.slice(0, 3) : [],
    }));
  }

  class VisionControlState {
    constructor(saved = {}, gestureTemplates = []) {
      this.detectors = Object.fromEntries(DETECTORS.map((name) => [name, saved.detectors?.[name] === true]));
      const savedSlots = Array.isArray(saved.slots) ? saved.slots : [];
      const templateNames = Array.isArray(gestureTemplates)
        ? gestureTemplates.map((template) => cleanName(template?.name)).filter(Boolean)
        : [];
      this.slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
        id: index + 1,
        name: cleanName(savedSlots[index]?.name) || templateNames[index] || `Gesture ${index + 1}`,
      }));
    }

    detectorEnabled(name) {
      return DETECTORS.includes(name) && this.detectors[name] === true;
    }

    setDetector(name, enabled) {
      if (!DETECTORS.includes(name)) return false;
      this.detectors[name] = enabled === true;
      return true;
    }

    setSlotName(id, name) {
      const slot = this.slots[id - 1];
      if (!slot) return null;
      slot.name = cleanName(name);
      return slot;
    }

    slotForGesture(name) {
      const normalized = cleanName(name).toLowerCase();
      return this.slots.find((slot) => slot.name.toLowerCase() === normalized) || null;
    }

    controlForSlot(id) {
      return id >= 1 && id <= SLOT_COUNT ? `sensor.vision.gesture.${id}` : null;
    }

    describeHand(hand) {
      if (!hand?.active) return 'No hand';
      if (this.detectorEnabled('fist') && hand.fist) return 'Fist';
      if (this.detectorEnabled('pinch') && hand.pinch) return 'Pinch';
      if (this.detectorEnabled('victory') && hand.victory) return 'Victory';
      if (this.detectorEnabled('open') && hand.open) return 'Open hand';
      if (this.detectorEnabled('fingers')) return `${Math.round((hand.fingers || 0) * 5)} fingers`;
      return 'Hand tracked';
    }

    toJSON() {
      return {
        version: 1,
        detectors: { ...this.detectors },
        slots: this.slots.map((slot) => ({ id: slot.id, name: slot.name })),
      };
    }
  }

  global.VisionControlState = VisionControlState;
  global.VISION_DETECTORS = DETECTORS.slice();
  global.normalizeVisionGestureTemplates = normalizeVisionGestureTemplates;
})(typeof window !== 'undefined' ? window : globalThis);
