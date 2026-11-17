import test from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";

import { decodeZstdFrameConcat, scanZstdFrames } from "../src/zstd-frames.ts";

test("concatenated checksummed zstd frames are decoded in order", () => {
  const first = zstdCompressSync(Buffer.from('{"type":"session","version":4}\n'));
  const second = zstdCompressSync(Buffer.from('{"type":"user/message","seq":0}\n{"type":"turn/end","seq":1}\n'));
  const artifact = Buffer.concat([first, second]);
  const { frames, trailingIncomplete } = scanZstdFrames(artifact);
  assert.equal(frames.length, 2);
  assert.equal(trailingIncomplete, false);
  assert.equal(frames[0]?.start, 0);
  assert.equal(frames[0]?.end, first.length);
  assert.equal(frames[1]?.end, artifact.length);
  assert.equal(
    decodeZstdFrameConcat(artifact).toString("utf8"),
    '{"type":"session","version":4}\n{"type":"user/message","seq":0}\n{"type":"turn/end","seq":1}\n',
  );
});

test("an unfinished trailing frame is ignored rather than treated as corruption", () => {
  const complete = zstdCompressSync(Buffer.from("header\n"));
  const artifact = Buffer.concat([complete, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]);
  const { frames, trailingIncomplete } = scanZstdFrames(artifact);
  assert.equal(frames.length, 1);
  assert.equal(trailingIncomplete, true);
  assert.equal(decodeZstdFrameConcat(artifact).toString("utf8"), "header\n");
});
