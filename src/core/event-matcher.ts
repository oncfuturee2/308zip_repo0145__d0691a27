export class EventMatcher {
  isMatch(subscribedEventTypes: string, eventType: string): boolean {
    const subscribedTypes = subscribedEventTypes.split(',').map(t => t.trim());
    
    for (const subscribedType of subscribedTypes) {
      if (this.matchSingle(subscribedType, eventType)) {
        return true;
      }
    }
    
    return false;
  }

  private matchSingle(subscribedType: string, eventType: string): boolean {
    if (subscribedType === '*') {
      return true;
    }

    if (!subscribedType.includes('*')) {
      return subscribedType === eventType;
    }

    const regexPattern = this.wildcardToRegex(subscribedType);
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(eventType);
  }

  private wildcardToRegex(pattern: string): string {
    return pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
  }

  matchEndpoints(
    endpoints: Array<{ id: string; eventTypes: string }>,
    eventType: string
  ): string[] {
    return endpoints
      .filter(endpoint => this.isMatch(endpoint.eventTypes, eventType))
      .map(endpoint => endpoint.id);
  }
}
