"""本地假招聘站，用于验证 Electron 内置抓取引擎（不依赖真实平台与登录）。

启动：.venv/Scripts/python.exe scripts/fake_job_site.py 8199
"""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

JOBS = [
    ("1001", "AI 应用工程师", "星辰科技", "25-40K", "广州·天河", "3-5年", "本科",
     "负责 AI Agent 平台的落地交付，熟悉 Vue3 / TypeScript，能与客户沟通需求。"),
    ("1002", "前端开发工程师（Electron）", "云图信息", "20-30K", "广州·海珠", "3-5年", "本科",
     "负责桌面客户端开发，Electron + Vue3，参与产品迭代与性能优化。"),
    ("1003", "解决方案工程师", "智联未来", "18-28K", "深圳·南山", "1-3年", "大专",
     "面向客户做方案设计与演示，需要前端基础与较强沟通能力。"),
    ("2001", "AI 产品经理", "深智科技", "30-45K", "深圳·福田", "5-10年", "本科",
     "负责 AI 产品规划，梳理客户场景，推动模型能力落地。"),
    ("2002", "全栈工程师", "锐达网络", "22-35K", "杭州·西湖", "3-5年", "本科",
     "Node.js + Vue3 全栈开发，参与 AI 工具链建设。"),
    ("2003", "技术支持工程师", "博远软件", "12-18K", "广州·越秀", "1-3年", "大专",
     "负责产品部署与客户培训，需要一定脚本能力。"),
]

LIST_TMPL = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>假招聘站 列表</title></head>
<body><h1>搜索结果：{kw} · {city} · 第 {page} 页</h1><div id="list">
{cards}
</div><div class="pager"><a class="next" href="/list?kw={kw}&city={city}&page={next}">下一页</a></div>
</body></html>"""

CARD_TMPL = """<div class="job-card-wrapper">
  <a href="/job/{jid}.html"><span class="job-name">{title}</span></a>
  <h3 class="company-name"><a>{company}</a></h3>
  <span class="salary">{salary}</span>
  <span class="job-area">{area}</span>
</div>"""

DETAIL_TMPL = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title></head>
<body><h1>{title}</h1><div class="job-info"><span class="text">{exp}</span><span class="text">{edu}</span></div>
<div class="job-sec-text">{jd}</div></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        path = parsed.path

        if path == "/job" or path.startswith("/job/"):
            jid = path.rsplit("/", 1)[-1].replace(".html", "")
            hit = next((j for j in JOBS if j[0] == jid), None)
            if not hit:
                return self._send(404, "<h1>not found</h1>")
            body = DETAIL_TMPL.format(
                title=hit[1], exp=hit[5], edu=hit[6], jd=hit[7]
            )
            return self._send(200, body)

        kw = (qs.get("kw") or ["AI Agent"])[0]
        city = (qs.get("city") or ["广州"])[0]
        try:
            page = max(1, int((qs.get("page") or ["1"])[0]))
        except ValueError:
            page = 1

        start = (page - 1) * 3
        chunk = JOBS[start:start + 3]
        cards = "".join(
            CARD_TMPL.format(jid=j[0], title=j[1], company=j[2], salary=j[3], area=j[4])
            for j in chunk
        )
        next_page = page + 1 if start + 3 < len(JOBS) else page
        body = LIST_TMPL.format(kw=kw, city=city, page=page, cards=cards, next=next_page)
        # 首次访问即下发「登录 cookie」，用于验证登录检测链路
        self._send(200, body, cookie="fake_login=1; Path=/; Max-Age=86400")

    def _send(self, code: int, body: str, cookie: str | None = None) -> None:
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8199
    print(f"fake job site on http://127.0.0.1:{port}/list", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
