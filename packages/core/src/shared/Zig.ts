import type { HLJSApi, Language } from "highlight.js";

// Keep import-free at runtime: the web bundle and pi's own highlight.js (v10) both register it.

const KEYWORDS =
  "addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while";

const TYPES =
  "isize usize c_char c_short c_ushort c_int c_uint c_long c_ulong c_longlong c_ulonglong c_longdouble f16 f32 f64 f80 f128 bool anyopaque void noreturn type anyerror comptime_int comptime_float";

const LITERALS = "true false null undefined";

function grammar(hljs: HLJSApi): Language {
  return {
    name: "Zig",
    keywords: { keyword: KEYWORDS, type: TYPES, literal: LITERALS },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      { className: "string", begin: /\\\\/, end: /$/ },
      hljs.QUOTE_STRING_MODE,
      { className: "string", begin: /'(?:\\.|[^\\'])+'/ },
      { className: "built_in", begin: /@[A-Za-z_]\w*/ },
      { className: "type", begin: /\b[iu]\d+\b/ },
      { className: "title", begin: /(?<=\bfn\s+)[A-Za-z_]\w*/ },
      {
        className: "number",
        begin:
          /\b(?:0x[\da-fA-F_]+(?:\.[\da-fA-F_]+)?(?:[pP][-+]?\d+)?|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?)\b/,
      },
    ],
  };
}

export const Zig = { grammar };
