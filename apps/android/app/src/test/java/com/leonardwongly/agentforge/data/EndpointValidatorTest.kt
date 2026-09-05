package com.leonardwongly.agentforge.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointValidatorTest {
  @Test
  fun normalizeBaseUrl_addsHttpsAndTrimsTrailingSlash() {
    val result = EndpointValidator.normalizeBaseUrl(" agentforge-api.example.com/ ")

    assertEquals("https://agentforge-api.example.com", result.getOrThrow())
  }

  @Test
  fun normalizeBaseUrl_allowsLocalHttpForDevelopment() {
    val result = EndpointValidator.normalizeBaseUrl("http://10.0.2.2:4000/")

    assertEquals("http://10.0.2.2:4000", result.getOrThrow())
  }

  @Test
  fun normalizeBaseUrl_rejectsDeployedHttp() {
    val result = EndpointValidator.normalizeBaseUrl("http://agentforge.example.com")

    assertTrue(result.isFailure)
  }

  @Test
  fun normalizeBaseUrl_allowsIpv6LoopbackForLocalDevelopment() {
    val result = EndpointValidator.normalizeBaseUrl("http://[::1]:4000/")

    assertEquals("http://[::1]:4000", result.getOrThrow())
  }

  @Test
  fun normalizeBaseUrl_rejectsCredentialsAndRoutingDecorations() {
    for (input in
      listOf(
        "https://operator:secret@agentforge.example.com",
        "https://agentforge.example.com?redirect=https://evil.example",
        "https://agentforge.example.com/#oauth",
      )) {
      assertTrue("Expected base URL to be rejected: $input", EndpointValidator.normalizeBaseUrl(input).isFailure)
    }
  }
}
