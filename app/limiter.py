from slowapi import Limiter
from slowapi.util import get_remote_address

# Single shared limiter instance. Both app.main (middleware + exception
# handler) and app.routes (per-route @limiter.limit decorators) import THIS
# one, so the route decorators and the middleware agree on the same registry.

# Default applied to every route. Status polling is the one exception: the SPA
# hits /api/v1/status every 3-15s, which would exhaust a 100/hour budget within
# ~25 min of an open tab and then 429 every request (including the polls that
# detect the server stopping). That route carries its own much higher limit
# (see app.routes.server_status) instead of this default.
DEFAULT_RATE_LIMIT = "100/hour"
STATUS_RATE_LIMIT = "3800/hour"

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[DEFAULT_RATE_LIMIT],
)
