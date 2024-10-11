export const federatedAveraging = (weights) => {
  // Check if arrays are empty
  if (weights.length === 0) return [];

  const result = JSON.parse(JSON.stringify(weights[0])); // Deep copy of the first array
  const count = weights.length;
  
  // Recursive function to average values at each position
  function recursiveAverage(current, depth = 0) {
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        if (Array.isArray(current[i])) {
          recursiveAverage(current[i], i);
        } else {
          // Sum up the values at the current position
          let sum = 0;
          for (let j = 0; j < count; j++) {
            sum += weights[j][depth][i]; // Access the correct depth and index
          }
          result[depth][i] = sum / count; // Compute the average
        }
      }
    }
  }
  recursiveAverage(result);
  return result;
}