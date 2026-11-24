# Hava Hakemi

8 farklı hava modelini (ECMWF, ECMWF AI, GFS, ICON, ARPEGE, UKMO, JMA, GEM) karşılaştırıp
tek bir karar veren hava tahmini uygulaması. Veri: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0, anahtar gerektirmez).

- **Web:** https://furkankurt17.github.io/hava-hakemi/
- **APK:** [Sürümler sayfası](https://github.com/furkankurt17/hava-hakemi/releases/tag/apk-latest)

## Nasıl çalışır
- Her model Open-Meteo'dan ayrı istenir; yanıt vermeyen model sessizce düşer.
- Saatlik: modellerin kaçı ≥0,1 mm yağış görüyor. Günlük: kaçı ≥0,5 mm.
- Güven: sıcaklık farkı (en uçtaki birer model hariç) ve yağış oylarının ne kadar net olduğu.
- Arayüz renkleri ve arka plan animasyonu o anki havaya göre değişir.

## Klasörler
- `www/` : Uygulamanın kendisi (index.html, style.css, app.js). GitHub Pages bu klasörü yayınlar.
- `capacitor.config.json` : APK kabuğu. Siteyi açar, böylece arayüz güncellemeleri APK'yı yeniden kurmadan gelir.
- `.github/workflows/pages.yml` : `www/` değişince siteyi yayınlar.
- `.github/workflows/android.yml` : Kabuk ayarları değişince APK derleyip `apk-latest` sürümüne koyar.
- `.github/workflows/karne.yml` + `scripts/karne.mjs` : Doğruluk karnesi (her gün 03:47).
- `www/data/` : Karne verisi (tahmin kayıtları, gözlemler, puanlar, özet). Bot tarafından yazılır.

## Doğruluk karnesi
- Şehirler ve istasyonlar: İstanbul (LTFJ), Ankara (LTAC), İzmir (LTBJ), Antalya (LTAI), Trabzon (LTCG).
- Gözlem: havalimanı METAR raporları ([aviationweather.gov](https://aviationweather.gov/)). Sıcaklık saat başına en yakın rapordan,
  yağış o saatteki raporlarda yağış grubu (RA, DZ, SN, SHRA, TSRA...) olup olmadığından.
- Her gün bugün (aynı gün) ve yarın (1 gün önceden) için tüm modellerin tahmini kaydedilir, gün bitince ölçümle karşılaştırılır.
- Puanlar: sıcaklık için ortalama mutlak hata (°C), yağış için "o gün yağdı mı" sorusunu doğru bilme oranı. Son 30 gün.
- Uygulama, konuma 150 km'den yakın bir şehrin en az 5 günlük karnesi varsa sıcaklık ortak görüşünü 1/hata² ağırlıklı ortalamayla hesaplar.
