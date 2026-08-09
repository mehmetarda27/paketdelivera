import type { CapacitorConfig } from "@capacitor/cli";

const courierUrl = "https://deliveraexpres.com.tr/courier.html";

const config: CapacitorConfig = {
  appId: "com.delivera.paket",
  appName: "Delivera",
  webDir: "mobile-web",
  server: {
    url: courierUrl,
    cleartext: false,
    androidScheme: "https",
    allowNavigation: [
      "deliveraexpres.com.tr",
      "*.deliveraexpres.com.tr",
      "*.google.com",
      "*.google.com.tr",
      "*.googleapis.com",
      "*.gstatic.com",
      "*.googleusercontent.com",
      "*.firebaseio.com",
      "*.firebaseapp.com",
    ],
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1200,
      backgroundColor: "#07110d",
      androidSplashResourceName: "splash",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#07110d",
    },
  },
};

export default config;
