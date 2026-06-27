import type { CapacitorConfig } from "@capacitor/cli";

const courierUrl = "https://paketdelivera-1.onrender.com/courier.html";

const config: CapacitorConfig = {
  appId: "com.delivera.paket",
  appName: "Delivera Paket",
  webDir: "mobile-web",
  server: {
    url: courierUrl,
    cleartext: false,
    androidScheme: "https",
    allowNavigation: [
      "paketdelivera-1.onrender.com",
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
