"""简历解析：文本 / 文件 → 结构化简历。"""
import io
from pathlib import Path

from .llm import get_llm
from .prompts import RESUME_PARSE_PROMPT
from .utils import extract_json, text_of


def parse_resume(resume_text: str) -> dict:
    llm = get_llm(temperature=0.0)
    prompt = RESUME_PARSE_PROMPT.format(resume_text=resume_text)
    resp = llm.invoke(prompt)
    return extract_json(text_of(resp))


def extract_resume_text(filename: str, content: bytes) -> str:
    """从上传的简历文件中提取纯文本。支持 PDF / DOCX / 文本文件。"""
    suffix = Path(filename).suffix.lower()

    if suffix == ".pdf":
        import pymupdf as fitz
        doc = fitz.open(stream=content, filetype="pdf")
        try:
            return "\n".join(page.get_text() for page in doc)
        finally:
            doc.close()

    if suffix == ".docx":
        import docx
        d = docx.Document(io.BytesIO(content))
        parts = [p.text for p in d.paragraphs if p.text.strip()]
        for table in d.tables:
            for row in table.rows:
                for cell in row.cells:
                    if cell.text.strip():
                        parts.append(cell.text.strip())
        return "\n".join(parts)

    # .txt / .md / 其他文本
    for enc in ("utf-8", "gbk"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="ignore")
