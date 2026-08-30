export class Levenshtein {
  public static distance(left: string, right: string): number {
    if (left === right) {
      return 0;
    }
    if (left.length === 0 || right.length === 0) {
      return Math.max(left.length, right.length);
    }

    let previous = Array.from(
      { length: right.length + 1 },
      (_, index) => index
    );
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
}
