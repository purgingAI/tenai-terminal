"""Pull the company SMTP relay settings (read-only) the way the Learn page does, for TenAI's OTP emails.
Prints shell exports for host/port/user/from and writes the password to the secrets file given as argv[1]."""
import os, shlex, sys
sys.path.insert(0, os.path.expanduser("~/amp/cx"))
from devdb import _vault_config  # noqa: E402

cfg = _vault_config()
user = cfg["email-config.sender-email"]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, cfg["email-config.sender-password"].encode()); os.close(fd)
for k, v in {"TENAI_SMTP_HOST": cfg["email-config.host"], "TENAI_SMTP_PORT": cfg["email-config.port"],
             "TENAI_SMTP_USER": user, "TENAI_SMTP_FROM": f"TenAI <{user}>", "TENAI_SMTP_PASS_FILE": sys.argv[1]}.items():
    print(f"export {k}={shlex.quote(str(v))}")
