"""Gera o .zip da extensão para a página de Releases.

Uso:  python scripts/build-zip.py
Saída: dist/liga-yugioh-precos-v<versão>.zip

O zip contém a pasta liga-yugioh-precos/ com apenas o necessário para o Chrome
(manifest, src, icons) mais LICENSE e README. Ao extrair, é essa pasta que o
usuário seleciona em "Carregar sem compactação".
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDER = "liga-yugioh-precos"
INCLUDE = ["manifest.json", "LICENSE", "README.md", "src", "icons"]

version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
target = dist / f"{FOLDER}-v{version}.zip"

with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
    for item in INCLUDE:
        path = ROOT / item
        files = sorted(p for p in path.rglob("*") if p.is_file()) if path.is_dir() else [path]
        for file in files:
            zf.write(file, f"{FOLDER}/{file.relative_to(ROOT).as_posix()}")

print(target.relative_to(ROOT).as_posix())
