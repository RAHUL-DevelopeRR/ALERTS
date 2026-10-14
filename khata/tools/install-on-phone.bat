@echo off
REM Install (or update) Kadan Kanakku on an Android phone connected by USB (Windows).
REM Usage: install-on-phone.bat kadan-kanakku-1.0.0.apk
set APK=%1
if "%APK%"=="" set APK=kadan-kanakku-1.0.0.apk
where adb >nul 2>nul || (echo adb not found. Install Android platform-tools and add it to PATH. & exit /b 1)
if not exist "%APK%" (echo APK not found: %APK% & exit /b 1)
adb start-server
adb devices -l
echo If the phone is not listed as "device": enable USB debugging and "Install via USB" in Developer options, then tap Allow on the phone.
adb install -r "%APK%"
adb shell monkey -p live.zerox.kadankanakku -c android.intent.category.LAUNCHER 1 >nul 2>nul
echo Done.
