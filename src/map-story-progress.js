const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

// Finish the state sequence halfway through the map section so its sticky copy has
// a substantial runway after Oklahoma before the next section takes over.
export const MAP_STORY_SEQUENCE_RANGE_RATIO = 0.5;

export function getMapStoryProgress(storyTravel, mapRange, zoomRange) {
  const sequenceRange = Math.max(1, mapRange) * MAP_STORY_SEQUENCE_RANGE_RATIO;
  return clamp((storyTravel - zoomRange) / sequenceRange);
}
