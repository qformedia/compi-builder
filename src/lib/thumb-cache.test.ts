import { describe, expect, it } from "vitest";
import { isPersistableThumbUrl } from "@/lib/thumb-cache";

describe("isPersistableThumbUrl", () => {
  it("rejects data URLs", () => {
    expect(isPersistableThumbUrl("data:image/jpeg;base64,abc")).toBe(false);
  });

  it("accepts durable HubSpot CDN URLs", () => {
    expect(
      isPersistableThumbUrl("https://146859718.fs1.hubspotusercontent-eu1.net/hubfs/146859718/thumb.jpg"),
    ).toBe(true);
    expect(
      isPersistableThumbUrl("https://cdn2.hubspot.com/hubfs/146859718/thumb.jpg"),
    ).toBe(true);
  });

  it("rejects known ephemeral CDN hosts", () => {
    expect(
      isPersistableThumbUrl("https://p16-sign-va.tiktokcdn.com/obj/tos-useast5-p-0068-tx/abc.jpeg"),
    ).toBe(false);
    expect(
      isPersistableThumbUrl("https://scontent.cdninstagram.com/v/t51.29350-15/abc.jpg"),
    ).toBe(false);
  });

  it("rejects signed/expiring query params", () => {
    expect(
      isPersistableThumbUrl("https://example.com/thumb.jpg?expires=1719999999&signature=abc"),
    ).toBe(false);
    expect(
      isPersistableThumbUrl("https://example.com/thumb.jpg?X-Amz-Signature=abc"),
    ).toBe(false);
  });

  it("accepts normal static https urls", () => {
    expect(isPersistableThumbUrl("https://example.com/static/thumb.jpg")).toBe(true);
  });
});

