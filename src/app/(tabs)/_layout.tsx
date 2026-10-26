import { NativeTabs } from 'expo-router/native-tabs';

export default function TabsLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(characters)">
        <NativeTabs.Trigger.Label>Characters</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.2" md="group" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="packs">
        <NativeTabs.Trigger.Label>Packs</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="shippingbox" md="inventory_2" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
