# IPADIC Build Supply

This directory vendors the one archive recorded in the app guide: mecab-ipadic 2.7.0-20250920 from `https://Lindera.dev/mecab-ipadic-2.7.0-20250920.tar.gz`, SHA-256 `a7ba9f645ffe7094e56ae1c4a81d100df8fbb1e28bbe1792622e9728e162db3d`. It is the verified R1 cached archive, copied without modification. `IPADIC-COPYING` is its exact full notice.

`scripts/retrieval-dictionary.py` verifies these bytes before populating Lindera's `5.3.0-fmt2` build cache. CI and App builds use this supply without an archive download. The expanded dictionary remains an uncommitted build artifact embedded into the target-matched executable.
