function distance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0 || right.length === 0) {
    return Math.max(left.length, right.length);
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost
      );
    }

    [previous, current] = [current, previous];
  }

  return previous[right.length] ?? 0;
}

/**
 * Damerau–Levenshtein, where a transposition is one edit rather than two, and
 * a pair that cannot reach `max` answers `max + 1` without finishing the
 * matrix — the shape a vocabulary scan wants, since almost every term it asks
 * about is nowhere near.
 */
function damerau(left: string, right: string, max: number): number {
  const over = max + 1;
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > max) {
    return over;
  }

  const width = right.length + 1;
  let before = Array.from({ length: width }, () => 0);
  let previous = Array.from({ length: width }, (_, index) => index);
  let current = Array.from({ length: width }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    let best = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      let value = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost
      );
      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        value = Math.min(value, before[rightIndex - 2]! + 1);
      }
      current[rightIndex] = value;
      best = Math.min(best, value);
    }

    if (best > max) {
      return over;
    }
    [before, previous, current] = [previous, current, before];
  }

  const found = previous[right.length]!;
  return found > max ? over : found;
}

export const Levenshtein = { distance, damerau };
