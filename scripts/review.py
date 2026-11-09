"""Create and manage UI Review Toolkit sessions from a trusted terminal."""

import argparse
import getpass
import ipaddress
import json
import os
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_token(path):
    if path.is_file():
        if path.stat().st_mode & 0o077:
            raise SystemExit("API token file must be private: chmod 600 " + str(path))
        return json.loads(path.read_text())["token"]
    return getpass.getpass("Owner or assigned agent API token: ").strip()


def request(base, token, route, method="GET", body=None):
    url = urlsplit(base)
    try:
        local = bool(url.hostname) and (
            url.hostname == "localhost" or ipaddress.ip_address(url.hostname).is_loopback
        )
    except ValueError:
        local = False
    if (
        not url.hostname
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or url.path not in {"", "/"}
        or (url.scheme != "https" and not (url.scheme == "http" and local))
    ):
        raise SystemExit("API must be an HTTPS origin (HTTP is allowed on loopback).")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers |= {"Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())}
    req = Request(
        f"{base.rstrip('/')}/v1/review-next{route}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with build_opener(NoRedirect()).open(req, timeout=20) as response:
            return json.load(response)
    except HTTPError as exc:
        raise SystemExit(f"UI Review returned HTTP {exc.code}. Check access and the latest session revision.") from None
    except URLError:
        raise SystemExit("Could not reach the UI Review API.") from None


def private_json(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")


def session_file(args):
    path = args.output if getattr(args, "output", None) else Path(".review") / f"{args.command}-{uuid.uuid4().hex[:12]}.json"
    if path.exists():
        raise SystemExit("Output already exists; choose a new path.")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=os.environ.get("UI_REVIEW_API", "http://127.0.0.1:8781"))
    parser.add_argument("--token-file", type=Path, default=Path(".review/owner.json"))
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="Create a session and save its private link and public embed snippet")
    create.add_argument("page_url")
    create.add_argument("--title")
    create.add_argument("--output", type=Path)
    create.add_argument("--ask-passcode", action="store_true")
    create.add_argument("--assigned-agent-id")
    demo = sub.add_parser("demo", help="Create a synthetic review page for the local quickstart")
    demo.add_argument("--port", type=int, default=8782)
    demo.add_argument("--output", type=Path)
    demo.add_argument("--ask-passcode", action="store_true")
    for verb in ("link", "snippet"):
        command = sub.add_parser(verb)
        command.add_argument("file", type=Path)
    sub.add_parser("list")
    show = sub.add_parser("show")
    show.add_argument("session")
    events = sub.add_parser("events")
    events.add_argument("session")
    events.add_argument("--after", type=int, default=0)
    for verb in ("reply", "state"):
        command = sub.add_parser(verb)
        command.add_argument("session")
        command.add_argument("annotation")
        command.add_argument("--text-file", type=Path)
        command.add_argument("--state", choices=["acknowledged", "fixed", "dismissed", "reopened"])
        command.add_argument("--revision", type=int, required=True, help="Current session revision")
    lifecycle = sub.add_parser("lifecycle")
    lifecycle.add_argument("session")
    lifecycle.add_argument("action", choices=["finish", "reopen", "archive", "expire"])
    lifecycle.add_argument("--revision", type=int, required=True)
    lifecycle.add_argument("--output", type=Path, help="Private file for the new reviewer link (reopen)")
    lifecycle.add_argument("--ask-passcode", action="store_true")
    args = parser.parse_args()

    if args.command in {"link", "snippet"}:
        record = json.loads(args.file.read_text())
        print(record["reviewerUrl" if args.command == "link" else "snippet"])
        return
    token = read_token(args.token_file)
    if args.command in {"create", "demo"}:
        path = session_file(args)
        body = {"mode": "next"}
        if args.command == "demo":
            body |= {"pageUrl": f"http://127.0.0.1:{args.port}/", "title": "UI Review Toolkit demo"}
        else:
            body |= {"pageUrl": args.page_url, "title": args.title}
            if args.assigned_agent_id:
                body["assignedAgentId"] = args.assigned_agent_id
        if args.ask_passcode:
            body["passcode"] = getpass.getpass("New reviewer passcode: ")
        result = request(args.api, token, "?mode=next", "POST", body)
        private_json(path, result)
        if args.command == "demo":
            preview_dir = Path(".review/demo")
            preview_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            fixture = (ROOT / "clients/ui-review/fixtures/static-review.html").read_text()
            (preview_dir / "index.html").write_text(fixture.replace("<!-- UI_REVIEW_SNIPPET -->", result["snippet"]))
            print(f"Serve the demo: python3 -m http.server {args.port} --bind 127.0.0.1 --directory {preview_dir}")
        print(f"Session: {result['sessionId']}\nPrivate session file: {path}")
        return
    if args.command == "list":
        result = request(args.api, token, "")
    else:
        route = "/" + quote(args.session, safe="")
        if args.command == "show":
            result = request(args.api, token, route)
        elif args.command == "events":
            result = request(args.api, token, f"{route}/events?after={args.after}")
        elif args.command in {"reply", "state"}:
            text = args.text_file.read_text().rstrip("\n") if args.text_file else None
            payload = {"baseRevision": args.revision}
            if args.command == "reply":
                if not text:
                    parser.error("reply requires a nonempty --text-file")
                payload["text"] = text
                action = "replies"
            else:
                if not args.state:
                    parser.error("state requires --state")
                payload |= {"state": args.state, "fixSummary": text}
                action = "state"
            result = request(args.api, token, f"{route}/annotations/{quote(args.annotation, safe='')}/{action}", "POST", payload)
        else:
            payload = {"baseRevision": args.revision}
            if args.action == "reopen":
                path = session_file(args)
                if args.ask_passcode:
                    payload["passcode"] = getpass.getpass("New reviewer passcode: ")
            result = request(args.api, token, f"{route}/{args.action}", "POST", payload)
            if args.action == "reopen":
                private_json(path, result)
                print(f"Private session file: {path}")
                return
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
