# Step 1: train JenaXI-1's OWN tokenizer (SentencePiece BPE, 32k) on a sample of her training text.
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_config, run_dir, work_dir, sources, load_persona, MAMA, JENA, SYSTEM
from reader import SourceReader
import sentencepiece as spm

def main():
    cfg = load_config()
    out = os.path.join(run_dir(), "tokenizer")
    if os.path.exists(os.path.join(out, "jenaxi1.model")):
        print("Tokenizer already on Drive, skipping (", out, ")"); return
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    sample = os.path.join(work_dir(), "tok_sample.txt")
    budget = cfg["tok_sample_mb"] * 1_000_000
    with open(sample, "w", encoding="utf-8") as f:
        for src in sources():
            want, got = int(budget * src["weight"]), 0
            # read from the END of the source list so tokenizer text is not the same text the model starts on
            r = SourceReader(src, {"fi": len(SourceReader(src).files) - 1, "row": 0})
            for d in r.docs():
                for line in d.split("\n"):
                    line = line.strip()
                    if len(line) > 20:
                        f.write(line[:4000] + "\n"); got += len(line)
                if got >= want: break
            print(f"  tokenizer sample: {src['name']:12s} {got/1e6:.1f} MB", flush=True)
        for _ in range(5):
            for c in load_persona():
                for t in c["turns"]:
                    f.write(t["user"] + "\n" + t["jena"] + "\n")
    print("Training tokenizer (takes a few minutes)...", flush=True)
    spm.SentencePieceTrainer.train(
        input=sample, model_prefix=os.path.join(out, "jenaxi1"), model_type="bpe", vocab_size=cfg["vocab_size"],
        character_coverage=0.9995, input_sentence_size=1_500_000 if cfg["vocab_size"] > 5000 else 200_000,
        shuffle_input_sentence=True, byte_fallback=True, split_digits=True,
        unk_id=0, bos_id=1, eos_id=2, pad_id=-1, user_defined_symbols=[MAMA, JENA, SYSTEM],
        num_threads=os.cpu_count() or 2, normalization_rule_name="identity", remove_extra_whitespaces=False,
        allow_whitespace_only_pieces=True, max_sentence_length=8000, train_extremely_large_corpus=False,
        minloglevel=2)
    sp = spm.SentencePieceProcessor(model_file=os.path.join(out, "jenaxi1.model"))
    print("Tokenizer ready:", sp.vocab_size(), "tokens,", f"{time.time()-t0:.0f}s")
    print("  example:", sp.encode(MAMA + "hi jena\n" + JENA + "HEY MAMA. im not some clanker.", out_type=str)[:24])

if __name__ == "__main__":
    main()
