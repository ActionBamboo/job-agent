"""文件上传解析测试：PDF / TXT 上传 → 结构化简历（演示模式，不调用真实 LLM）。"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import settings

settings.demo_mode = True  # 用 MockLLM

import pymupdf as fitz
from fastapi.testclient import TestClient

from app.main import app

c = TestClient(app)


def make_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_textbox(fitz.Rect(72, 72, 550, 300), text)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def make_docx() -> bytes:
    import docx
    d = docx.Document()
    d.add_paragraph("王五 AI 工程师 Python LangGraph")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def main() -> int:
    # PDF 上传
    pdf = make_pdf("张三\nAI 应用工程师\n3 年经验\nPython LangGraph RAG")
    r = c.post("/resume/upload", files={"file": ("resume.pdf", pdf, "application/pdf")})
    assert r.status_code == 200, r.text
    d = r.json()
    print("pdf upload ok:", d.get("name"), "/", d.get("title"))

    # TXT 上传
    r2 = c.post("/resume/upload", files={"file": ("resume.md", "李四\nAI 工程师\nPython".encode("utf-8"), "text/markdown")})
    assert r2.status_code == 200, r2.text
    print("txt upload ok:", r2.json().get("name"))

    # DOCX 上传
    r_docx = c.post("/resume/upload", files={"file": ("resume.docx", make_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r_docx.status_code == 200, r_docx.text
    print("docx upload ok:", r_docx.json().get("name"))

    # 上传后能直接批量匹配
    r3 = c.post("/match/batch", json={})
    assert r3.status_code == 200, r3.text
    print("batch after upload ok, count:", len(r3.json()))
    print("UPLOAD_TEST_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
