# ADR 0004 · Browser invitation scanning

Use a lazy-loaded JavaScript QR decoder for camera frames and selected images. This gives both flows the same
decoding behavior across browsers with and without the native BarcodeDetector API. The app processes images locally,
caps decoder input at 1,024 pixels per edge, and accepts PNG, JPEG and WebP files up to 8 MiB through the image
picker.

Request the rear camera where available and release media tracks when a scan completes, the tab becomes hidden, a
timeout expires, or the scanner closes. Browsers without camera access can use the file picker or paste a link.

Use the same origin and fragment validation for scanned and pasted links. A scan presents its invitation type and
waits for explicit review. The existing authenticated review and acceptance flow still controls membership and
contact requests.
