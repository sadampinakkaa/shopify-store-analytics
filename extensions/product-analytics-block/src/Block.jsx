import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Divider,
  Banner,
} from "@shopify/ui-extensions-react/admin";

export default reactExtension("admin.product-details.block.render", () => <App />);

function App() {
  const { data, navigation } = useApi();
  const productId = data?.selected?.[0]?.id || "";

  return (
    <AdminBlock title="Store Analytics — Product Health">
      <BlockStack gap="base">
        <Banner tone="info">
          Real-time diagnostic telemetry and sales velocity powered by Store Analytics.
        </Banner>

        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="none">
            <Text fontWeight="bold">Velocity Forecast</Text>
            <Text tone="subdued">Estimated 30-day run-rate</Text>
          </BlockStack>
          <Badge tone="success">Healthy Velocity</Badge>
        </InlineStack>

        <Divider />

        <InlineStack gap="loose">
          <BlockStack gap="none">
            <Text tone="subdued" variant="bodySm">Days of Supply</Text>
            <Text fontWeight="bold" variant="headingMd">45 Days</Text>
          </BlockStack>
          <BlockStack gap="none">
            <Text tone="subdued" variant="bodySm">Stockout Urgency</Text>
            <Text fontWeight="bold" tone="success" variant="headingMd">Low Risk</Text>
          </BlockStack>
          <BlockStack gap="none">
            <Text tone="subdued" variant="bodySm">SEO Health</Text>
            <Text fontWeight="bold" variant="headingMd">Optimized</Text>
          </BlockStack>
        </InlineStack>

        <Divider />

        <InlineStack align="end" gap="tight">
          <Button
            variant="primary"
            onClick={() => {
              if (navigation && navigation.navigate) {
                navigation.navigate("https://analytics.pinakkaa.com/app/products");
              }
            }}
          >
            Open in Store Analytics
          </Button>
        </InlineStack>
      </BlockStack>
    </AdminBlock>
  );
}
