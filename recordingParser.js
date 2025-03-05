export function parseRecording(jsonRecording) {
  // 1. Convert string to object if necessary
  // If you already have it as an object, skip the parse step
  let recording;
  if (typeof jsonRecording === 'string') {
    recording = JSON.parse(jsonRecording);
  } else {
    recording = jsonRecording;
  }

  // 2. The array of steps (like recording.steps)
  const steps = recording.steps || [];

  // 3. Convert each step into a simpler structure
  //    For example, gather user-friendly info: which CSS selectors exist, the type of event, etc.
  const parsedSteps = steps.map((step, index) => {
    return {
      index,
      type: step.type,                   // e.g. 'click', 'change', etc.
      selectors: step.selectors || [],   // all possible ways to locate the element
      value: step.value || null,         // only if type === 'change'
      description: `Step ${index + 1}: ${step.type} event`
    };
  });

  return parsedSteps;
} 