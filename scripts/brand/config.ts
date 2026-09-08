export type LogoStyle = {
  readonly glyphs: readonly (readonly string[])[];
  readonly color: string;
  readonly pixel: number;
  readonly gap: number;
  readonly radius: number;
  readonly spacing: number;
  readonly padding: number;
};

export const style = {
  glyphs: [
    ["1110", "1001", "1110", "1000", "1000"],
    ["111", "010", "010", "010", "111"],
    ["10001", "11011", "10101", "10001", "10001"],
  ],
  color: "#818cf8",
  pixel: 12,
  gap: 0,
  radius: 0,
  spacing: 1,
  padding: 1,
} satisfies LogoStyle;

export const iconBackground = "#242725";
