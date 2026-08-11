import json
import os
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import ttk, messagebox
from urllib import error, request


def find_project_dir() -> Path:
    base = Path(__file__).resolve().parent
    if (base / "server.js").exists():
        return base
    if (base.parent / "server.js").exists():
        return base.parent
    return base


class AdminLauncher(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Astro Admin Launcher")
        self.geometry("980x680")

        self.project_dir = find_project_dir()
        self.server_path = self.project_dir / "server.js"
        self.process: subprocess.Popen | None = None
        self.started_by_app = False
        self.token = ""

        self.host_var = tk.StringVar(value="127.0.0.1")
        self.port_var = tk.StringVar(value="8080")
        self.password_var = tk.StringVar(value="Delta1/6")
        self.shortcut_var = tk.StringVar(value="delta1/6")
        self.status_var = tk.StringVar(value="Server: stopped")

        self._build_ui()
        self.after(800, self.poll_process)
        self.after(1000, self.auto_refresh_events)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    @property
    def api_base(self) -> str:
        return f"http://{self.host_var.get().strip()}:{self.port_var.get().strip()}"

    def _build_ui(self) -> None:
        container = ttk.Frame(self, padding=12)
        container.pack(fill="both", expand=True)

        top = ttk.LabelFrame(container, text="Server")
        top.pack(fill="x")

        ttk.Label(top, text="Host").grid(row=0, column=0, padx=6, pady=8, sticky="w")
        ttk.Entry(top, textvariable=self.host_var, width=16).grid(row=0, column=1, padx=6, pady=8, sticky="w")
        ttk.Label(top, text="Port").grid(row=0, column=2, padx=6, pady=8, sticky="w")
        ttk.Entry(top, textvariable=self.port_var, width=10).grid(row=0, column=3, padx=6, pady=8, sticky="w")

        ttk.Button(top, text="Start server", command=self.start_server).grid(row=0, column=4, padx=6, pady=8)
        ttk.Button(top, text="Stop server", command=self.stop_server).grid(row=0, column=5, padx=6, pady=8)
        ttk.Button(top, text="Open page", command=self.open_page).grid(row=0, column=6, padx=6, pady=8)

        ttk.Label(top, textvariable=self.status_var).grid(row=1, column=0, columnspan=7, padx=6, pady=6, sticky="w")

        auth = ttk.LabelFrame(container, text="Admin")
        auth.pack(fill="x", pady=(10, 0))

        ttk.Label(auth, text="Password").grid(row=0, column=0, padx=6, pady=8, sticky="w")
        ttk.Entry(auth, textvariable=self.password_var, width=26, show="*").grid(row=0, column=1, padx=6, pady=8, sticky="w")
        ttk.Button(auth, text="Login", command=self.login).grid(row=0, column=2, padx=6, pady=8)
        ttk.Button(auth, text="Load shortcut", command=self.load_shortcut).grid(row=0, column=3, padx=6, pady=8)

        ttk.Label(auth, text="Shortcut").grid(row=1, column=0, padx=6, pady=8, sticky="w")
        ttk.Entry(auth, textvariable=self.shortcut_var, width=26).grid(row=1, column=1, padx=6, pady=8, sticky="w")
        ttk.Button(auth, text="Save shortcut", command=self.save_shortcut).grid(row=1, column=2, padx=6, pady=8)

        events_box = ttk.LabelFrame(container, text="Login events")
        events_box.pack(fill="both", expand=True, pady=(10, 0))

        toolbar = ttk.Frame(events_box)
        toolbar.pack(fill="x", padx=6, pady=6)
        ttk.Button(toolbar, text="Refresh", command=self.refresh_events).pack(side="left")

        columns = ("time", "os", "browser", "city", "country", "ip", "status")
        self.tree = ttk.Treeview(events_box, columns=columns, show="headings", height=18)
        self.tree.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        widths = {
            "time": 70,
            "os": 100,
            "browser": 120,
            "city": 120,
            "country": 120,
            "ip": 140,
            "status": 90,
        }
        for name in columns:
            self.tree.heading(name, text=name.upper())
            self.tree.column(name, width=widths[name], anchor="center")

        self.log_text = tk.Text(container, height=8)
        self.log_text.pack(fill="both", expand=False, pady=(10, 0))
        self.log_text.configure(state="disabled")

    def log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"{text}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def open_page(self) -> None:
        import webbrowser

        webbrowser.open(f"{self.api_base}/apka1/")

    def start_server(self) -> None:
        if self.process and self.process.poll() is None:
            messagebox.showinfo("Info", "Server juz dziala.")
            return

        if not self.server_path.exists():
            messagebox.showerror("Blad", f"Brak pliku: {self.server_path}")
            return

        env = os.environ.copy()
        env["HOST"] = self.host_var.get().strip()
        env["PORT"] = self.port_var.get().strip()

        try:
            self.process = subprocess.Popen(
                ["node", str(self.server_path)],
                cwd=str(self.project_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            self.started_by_app = True
            self.status_var.set(f"Server: starting on {self.api_base}")
            self.log("Server start requested.")
            threading.Thread(target=self._read_output, daemon=True).start()
        except FileNotFoundError:
            messagebox.showerror("Blad", "Nie znaleziono Node.js. Zainstaluj node.")

    def _read_output(self) -> None:
        if not self.process or not self.process.stdout:
            return
        for line in self.process.stdout:
            self.after(0, self.log, line.rstrip())

    def stop_server(self) -> None:
        if not self.process or self.process.poll() is not None:
            self.status_var.set("Server: stopped")
            return

        self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.status_var.set("Server: stopped")
        self.log("Server stopped.")

    def poll_process(self) -> None:
        if self.process and self.process.poll() is None:
            self.status_var.set(f"Server: running on {self.api_base}")
        elif self.process and self.process.poll() is not None:
            code = self.process.returncode
            self.status_var.set(f"Server: stopped (exit {code})")
        self.after(800, self.poll_process)

    def _request(self, method: str, path: str, data: dict | None = None, auth: bool = False) -> dict:
        url = f"{self.api_base}{path}"
        payload = None
        headers = {"Content-Type": "application/json"}

        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        if data is not None:
            payload = json.dumps(data).encode("utf-8")

        req = request.Request(url=url, method=method, data=payload, headers=headers)
        try:
            with request.urlopen(req, timeout=4) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except error.HTTPError as exc:
            message = exc.read().decode("utf-8")
            try:
                parsed = json.loads(message)
                raise RuntimeError(parsed.get("error") or message)
            except json.JSONDecodeError:
                raise RuntimeError(message or str(exc)) from exc
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc

    def login(self) -> None:
        password = self.password_var.get().strip()
        if not password:
            messagebox.showwarning("Info", "Podaj haslo.")
            return

        try:
            payload = self._request("POST", "/api/admin/login", {"password": password}, auth=False)
            self.token = str(payload.get("token", ""))
            if not self.token:
                raise RuntimeError("Brak tokena w odpowiedzi.")
            self.log("Admin login: success")
            self.load_shortcut()
            self.refresh_events()
            messagebox.showinfo("OK", "Zalogowano admina.")
        except RuntimeError as exc:
            messagebox.showerror("Blad logowania", str(exc))

    def load_shortcut(self) -> None:
        try:
            payload = self._request("GET", "/api/settings", auth=False)
            shortcut = str(payload.get("shortcut", "delta1/6"))
            self.shortcut_var.set(shortcut)
            self.log(f"Shortcut loaded: {shortcut}")
        except RuntimeError as exc:
            messagebox.showerror("Blad", str(exc))

    def save_shortcut(self) -> None:
        if not self.token:
            messagebox.showwarning("Info", "Najpierw zaloguj admina.")
            return

        shortcut = self.shortcut_var.get().strip().lower()
        if not shortcut:
            messagebox.showwarning("Info", "Shortcut nie moze byc pusty.")
            return

        try:
            self._request("PUT", "/api/settings/shortcut", {"shortcut": shortcut}, auth=True)
            self.log(f"Shortcut saved: {shortcut}")
            messagebox.showinfo("OK", "Shortcut zapisany.")
        except RuntimeError as exc:
            messagebox.showerror("Blad", str(exc))

    def refresh_events(self) -> None:
        if not self.token:
            return

        try:
            payload = self._request("GET", "/api/admin/login-events?limit=200", auth=True)
            events = payload.get("events", [])
            self.tree.delete(*self.tree.get_children())
            for event in events:
                self.tree.insert(
                    "",
                    "end",
                    values=(
                        event.get("time", "--:--"),
                        event.get("os", "Unknown"),
                        event.get("browser", "Unknown"),
                        event.get("city", "Unknown"),
                        event.get("country", "Unknown"),
                        event.get("ip", "unknown"),
                        event.get("status", "unknown"),
                    ),
                )
            self.log(f"Events refreshed: {len(events)}")
        except RuntimeError as exc:
            self.log(f"Events refresh failed: {exc}")

    def auto_refresh_events(self) -> None:
        if self.token:
            self.refresh_events()
        self.after(10000, self.auto_refresh_events)

    def on_close(self) -> None:
        if self.started_by_app:
            self.stop_server()
        self.destroy()


if __name__ == "__main__":
    app = AdminLauncher()
    app.mainloop()
