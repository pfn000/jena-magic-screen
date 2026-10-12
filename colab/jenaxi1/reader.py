# Resumable reader over Hugging Face parquet files: position = (file index, row index).
import pyarrow.parquet as pq
from common import hf_file, resolve_files, clean_gutenberg

class SourceReader:
    def __init__(self, src, state=None):
        self.src = src
        self.files = resolve_files(src)
        st = state or {}
        self.fi, self.row = st.get("fi", 0), st.get("row", 0)
        self._pf = None; self._pf_fi = None; self._rg = None

    def state(self):
        return {"fi": self.fi, "row": self.row}

    def _open(self):
        if self._pf_fi != self.fi:
            path = hf_file(self.src["repo"], self.files[self.fi % len(self.files)])
            self._pf = pq.ParquetFile(path); self._pf_fi = self.fi; self._rg = None
            starts, s = [], 0
            for i in range(self._pf.metadata.num_row_groups):
                starts.append(s); s += self._pf.metadata.row_group(i).num_rows
            self._starts, self._nrows = starts, s

    def docs(self):
        """Yields text documents forever (wraps around to the first file after the last)."""
        while True:
            self._open()
            if self.row >= self._nrows:
                self.fi += 1; self.row = 0
                continue
            gi = max(i for i, s in enumerate(self._starts) if s <= self.row)
            if self._rg is None or self._rg[0] != gi:
                self._rg = None
                self._rg = (gi, self._pf.read_row_group(gi, columns=["text"]).column("text"))   # Arrow column, no big Python copy
            texts, base = self._rg[1], self._starts[gi]
            while self.row - base < len(texts):
                t = texts[self.row - base].as_py()
                self.row += 1
                if not t: continue
                if self.src["name"] == "gutenberg": t = clean_gutenberg(t)
                yield t
