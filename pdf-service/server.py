import base64
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymupdf


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("PDF_SERVICE_PORT", "5681"))
DEFAULT_DPI = 150
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_PAGES = 10


def render_pdf_bytes(pdf_bytes: bytes, dpi: int, first_page_only: bool) -> dict:
    start = time.perf_counter()
    if not pdf_bytes:
        raise ValueError("Empty PDF payload")
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ValueError(f"PDF exceeds {MAX_PDF_BYTES} byte limit")

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        total_pages = doc.page_count
        if total_pages == 0:
            raise ValueError("PDF contains zero pages")

        pages_to_render = 1 if first_page_only else min(total_pages, MAX_PAGES)
        zoom = dpi / 72.0
        matrix = pymupdf.Matrix(zoom, zoom)
        pages_b64 = []

        for page_index in range(pages_to_render):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            png_bytes = pix.tobytes("png")
            pages_b64.append(base64.b64encode(png_bytes).decode("ascii"))
    finally:
        doc.close()

    elapsed_ms = round((time.perf_counter() - start) * 1000.0, 2)
    return {
        "mime_type": "image/png",
        "base64_data": pages_b64[0],
        "pages": pages_b64,
        "page_count": total_pages,
        "rendered_pages": len(pages_b64),
        "exceeds_page_limit": total_pages > MAX_PAGES,
        "dpi": dpi,
        "page_policy": "first_page_only" if first_page_only else "all_pages",
        "elapsed_ms": elapsed_ms,
    }


class PdfRenderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        return

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "renderer": "pymupdf", "pymupdf_version": pymupdf.__version__})
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/render":
            self._send_json(404, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > MAX_PDF_BYTES * 2:
            self._send_json(400, {"error": "Invalid Content-Length"})
            return

        raw_body = self.rfile.read(content_length)
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

        try:
            dpi = DEFAULT_DPI
            first_page_only = False

            if content_type == "application/pdf":
                pdf_bytes = raw_body
            elif content_type == "application/json":
                data = json.loads(raw_body.decode("utf-8"))
                b64_value = data.get("base64_data") or data.get("pdf_base64")
                if not b64_value or not isinstance(b64_value, str):
                    raise ValueError("Missing base64_data or pdf_base64 string")
                if b64_value.startswith("data:"):
                    _, b64_value = b64_value.split(",", 1)
                pdf_bytes = base64.b64decode(b64_value, validate=True)
                if "dpi" in data:
                    dpi = int(data["dpi"])
                    if dpi < 72 or dpi > 600:
                        raise ValueError("dpi must be between 72 and 600")
                if "first_page_only" in data:
                    first_page_only = bool(data["first_page_only"])
            else:
                self._send_json(415, {"error": f"Unsupported Content-Type: {content_type}"})
                return

            result = render_pdf_bytes(pdf_bytes, dpi=dpi, first_page_only=first_page_only)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), PdfRenderHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
