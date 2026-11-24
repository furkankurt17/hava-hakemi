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

## Sıradaki adım
Doğruluk karnesi: zamanlanmış bir iş akışı her gün modellerin tahminlerini ve istasyon ölçümlerini
JSON olarak depoya kaydedecek; modeller bölgeye göre puanlanıp ortak görüş ağırlıklandırılacak.
