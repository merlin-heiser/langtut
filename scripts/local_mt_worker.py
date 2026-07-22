#!/usr/bin/env python3
"""Small JSONL worker for explicitly installed local translation models."""

import argparse
import gc
import json
import sys
from pathlib import Path


def dependencies():
    try:
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        return torch, snapshot_download, AutoModelForSeq2SeqLM, AutoTokenizer
    except Exception as exc:
        raise RuntimeError("Installiere Python-Pakete: transformers torch sentencepiece huggingface_hub") from exc


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def install(args):
    _, snapshot_download, _, _ = dependencies()
    target = Path(args.directory).resolve()
    target.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=args.model,
        revision=args.revision,
        local_dir=str(target),
        allow_patterns=["*.json", "*.model", "*.spm", "*.safetensors", "pytorch_model.bin"],
    )
    emit({"ok": True, "path": str(target)})


def serve():
    torch, _, model_class, tokenizer_class = dependencies()
    loaded = {}
    for line in sys.stdin:
        try:
            request = json.loads(line)
            model_path = request["modelPath"]
            cache_key = (model_path, request["family"])
            if cache_key not in loaded:
                loaded.clear()
                gc.collect()
                tokenizer = tokenizer_class.from_pretrained(model_path, local_files_only=True)
                model = model_class.from_pretrained(model_path, local_files_only=True)
                model.eval()
                loaded[cache_key] = (tokenizer, model)
            tokenizer, model = loaded[cache_key]
            family = request["family"]
            source = request["sourceLanguage"]
            target = request["targetLanguage"]
            if family == "m2m100":
                tokenizer.src_lang = source
            encoded = tokenizer(request["text"], return_tensors="pt", truncation=True, max_length=256)
            options = {"max_new_tokens": 96, "num_beams": 4}
            if family == "m2m100":
                options["forced_bos_token_id"] = tokenizer.get_lang_id(target)
            with torch.inference_mode():
                output = model.generate(**encoded, **options)
            translation = tokenizer.batch_decode(output, skip_special_tokens=True)[0].strip()
            emit({"id": request["id"], "translation": translation})
        except Exception as exc:
            emit({"id": request.get("id") if "request" in locals() else None, "error": str(exc)})


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe")
    installer = sub.add_parser("install")
    installer.add_argument("--model", required=True)
    installer.add_argument("--revision", required=True)
    installer.add_argument("--directory", required=True)
    sub.add_parser("serve")
    args = parser.parse_args()
    if args.command == "probe":
        try:
            dependencies()
            emit({"ok": True})
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})
    elif args.command == "install":
        install(args)
    else:
        serve()


if __name__ == "__main__":
    main()
