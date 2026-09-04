package dev.tokn_ai.rrbox

import android.app.Application

class RrboxApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    System.loadLibrary("researchbox_native")
    initializeTls()
  }

  private external fun initializeTls()
}
