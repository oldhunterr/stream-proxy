import sys, json, asyncio
from curl_cffi.requests import AsyncSession


async def main():
    url = sys.argv[1]
    headers = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    follow = sys.argv[3] if len(sys.argv) > 3 else "true"
    timeout = int(sys.argv[4]) if len(sys.argv) > 4 else 30

    async with AsyncSession() as s:
        r = await s.get(
            url,
            impersonate="chrome",
            headers=headers,
            allow_redirects=follow == "true",
            timeout=timeout,
        )

    print(json.dumps({
        "status": r.status_code,
        "text": r.text,
        "headers": dict(r.headers),
        "finalUrl": str(r.url),
    }))


if __name__ == "__main__":
    asyncio.run(main())
