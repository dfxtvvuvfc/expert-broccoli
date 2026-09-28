# Vodi VPN — Railway Production

پنل مینیمال Vodi VPN برای **VLESS + WebSocket** با Xray داخل همان سرویس Railway.

## ویژگی‌ها
- فقط VLESS + WebSocket
- مسیر پیش‌فرض `/vless`
- Xray داخل کانتینر
- Subscription استاندارد Base64
- هدر `subscription-userinfo` برای کلاینت‌های سازگار
- حجم و انقضا برای هر کانفیگ
- مصرف واقعی از Xray StatsService
- Reset مصرف
- فعال/غیرفعال کردن و حذف کانفیگ
- QR Code
- Login اولیه `admin / admin`
- تغییر رمز مدیر
- بدون PostgreSQL / Database
- ذخیره در `/data/vodi.json`
- مناسب Railway Volume
- صفحه Subscription سفید و مستقل

## Railway

1. Repository را در GitHub قرار بده.
2. در Railway از GitHub Repo دیپلوی کن.
3. یک Volume به سرویس Attach کن با Mount Path:

```text
/data
```

4. برای دامنه پایدار، Custom Domain یا Railway Public Domain سرویس را استفاده کن.
5. اگر Custom Domain داری، داخل Settings → VLESS / WebSocket دامنه را وارد کن. اگر خالی بگذاری، دامنه عمومی درخواست Railway استفاده می‌شود.

## لینک‌ها

- پنل: `/`
- صفحه Subscription: `/sub/<token>`
- لینک خام Subscription برای کلاینت: `/sub/<token>/raw`
- QR عمومی Subscription: `/sub/<token>/qr`

## نکته TLS

TLS در ورودی عمومی Railway انجام می‌شود و لینک VLESS به شکل WSS/TLS روی پورت 443 ساخته می‌شود؛ Xray داخل سرویس WebSocket را بدون TLS روی پورت داخلی دریافت می‌کند.

## ذخیره‌سازی

هیچ Databaseای استفاده نمی‌شود. داده‌های مدیریتی و کانفیگ‌ها در `/data/vodi.json` هستند. بدون Volume، فایل ذخیره‌شده روی filesystem موقت ممکن است بعد از redeploy از بین برود.
