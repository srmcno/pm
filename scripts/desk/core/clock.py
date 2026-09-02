#!/usr/bin/env python3
"""Eastern time, with a correct fallback when no tz database is installed.

`zoneinfo` needs the system tz database or the `tzdata` package. When
neither is present the old fallback was a fixed UTC-4, which is an hour
wrong from November to March — enough to put the auction windows in the
wrong place and refuse valid market-on-close orders all winter. The
fallback here applies the post-2007 US rule itself.
"""
import datetime as _dt

_H = _dt.timedelta(hours=1)


class USEastern(_dt.tzinfo):
    """US Eastern: DST from the second Sunday in March at 02:00 local to the
    first Sunday in November at 02:00 local."""

    @staticmethod
    def _bounds(year):
        march = _dt.datetime(year, 3, 1)
        start = march + _dt.timedelta(days=(6 - march.weekday()) % 7 + 7, hours=2)
        nov = _dt.datetime(year, 11, 1)
        end = nov + _dt.timedelta(days=(6 - nov.weekday()) % 7, hours=2)
        return start, end                       # local wall-clock instants

    def _in_dst(self, local_naive, fold=0):
        start, end = self._bounds(local_naive.year)
        if fold and end - _H <= local_naive < end:
            return False                    # the repeated hour, second pass: EST
        return start <= local_naive < end

    def utcoffset(self, dt):
        return -5 * _H + (self.dst(dt) or _dt.timedelta(0))

    def dst(self, dt):
        if dt is None:
            return _dt.timedelta(0)
        return (_H if self._in_dst(dt.replace(tzinfo=None), getattr(dt, "fold", 0))
                else _dt.timedelta(0))

    def tzname(self, dt):
        return "EDT" if self.dst(dt) else "EST"

    def fromutc(self, dt):
        std = (dt.replace(tzinfo=None) - 5 * _H)          # standard-time wall clock
        start, end = self._bounds(std.year)
        # DST starts at 02:00 EST; it ends at 02:00 EDT, which is 01:00 EST.
        if start <= std < end - _H:
            return (std + _H).replace(tzinfo=self)
        # 01:00-02:00 EST on the fall-back day is the second pass of a
        # repeated hour; mark it so utcoffset() resolves it as standard time.
        fold = 1 if end - _H <= std < end else 0
        return std.replace(tzinfo=self, fold=fold)


def eastern():
    """A tzinfo for America/New_York, from the tz database when available."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("America/New_York")
    except Exception:                                        # noqa: BLE001
        return USEastern()
